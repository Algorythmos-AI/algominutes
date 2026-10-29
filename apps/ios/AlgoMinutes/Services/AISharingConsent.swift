import Foundation
import Observation

/// Every way the app sends someone's audio or text to the AI pipeline (Google Cloud's speech and AI services).
/// Each one waits for the agreement (App Store guideline 5.1.2(i)).
enum AISharingPath: String, Sendable, CaseIterable {
    /// A microphone recording, asked before the recording starts.
    case recording
    /// A capture of another app's audio (the broadcast extension), asked before it's uploaded.
    case callCapture
    /// An imported audio file.
    case importAudio
    /// A scanned image or a document's text.
    case scan
    /// The meeting notetaker (its audio is transcribed and summarised the same way).
    case notetaker
    /// A question to Ask AI, about one note or every note.
    case askAI
    /// Searching what was said (the search words are matched by an AI model).
    case search
    /// Rewriting a summary.
    case regenerateSummary
    /// Trying a failed note again, which sends its recording or transcript again.
    case retry
    /// Recordings still on this iPhone, uploaded in the background.
    case pendingUploads
}

/// The one-time, per-device agreement to send recordings and their text to Google Cloud AI (App Store guideline
/// 5.1.2(i); docs/plans/APP-STORE-REVIEW-PACKAGE.md §5). Separate from the recording sheet's tick, which is about
/// other people's permission and is asked every time.
///
/// Stored with the version of the words agreed to: changing the words (`version`) asks again. Withdrawn in
/// Settings, after which nothing new is sent until it's agreed again.
@Observable
@MainActor
final class AISharingConsent {
    /// The version of the words in `AISharingCopy`. Bump it when they change, so everyone is asked again.
    static let version = 1
    nonisolated static let versionKey = "ai_sharing_consent.version"
    nonisolated static let agreedAtKey = "ai_sharing_consent.agreed_at"

    /// The app's one, on this device's standard defaults.
    static let shared = AISharingConsent()

    @ObservationIgnored private let defaults: UserDefaults
    /// The version of the words agreed to; 0 when never agreed, or withdrawn.
    private(set) var agreedVersion: Int

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.agreedVersion = defaults.integer(forKey: Self.versionKey)
    }

    /// Agreed to the current words.
    var isAgreed: Bool { Self.covers(stored: agreedVersion, current: Self.version) }

    /// Agreed once, to words that have since changed: asked again.
    var agreedToEarlierWords: Bool { agreedVersion > 0 && !isAgreed }

    /// Whether an agreement to the words of version `stored` covers the words of version `current`. 0 is none.
    nonisolated static func covers(stored: Int, current: Int) -> Bool {
        stored > 0 && stored >= current
    }

    var agreedAt: Date? {
        guard isAgreed else { return nil }
        return defaults.object(forKey: Self.agreedAtKey) as? Date
    }

    func agree(at date: Date = Date()) {
        defaults.set(Self.version, forKey: Self.versionKey)
        defaults.set(date, forKey: Self.agreedAtKey)
        agreedVersion = Self.version
        AppLog.info("ai_sharing_agreed version=\(Self.version)")
    }

    /// Stops every future upload until agreed again. What's already in the account stays there.
    func withdraw() {
        defaults.removeObject(forKey: Self.versionKey)
        defaults.removeObject(forKey: Self.agreedAtKey)
        agreedVersion = 0
        AppLog.info("ai_sharing_withdrawn")
    }

    /// Whether `path` may send now. A refusal is logged: nothing leaves the device for it.
    func allows(_ path: AISharingPath) -> Bool {
        if isAgreed { return true }
        AppLog.info("ai_sharing_blocked path=\(path.rawValue) agreedVersion=\(agreedVersion)")
        return false
    }

    /// Runs `proceed` now when agreed. Otherwise returns the request a view shows the agreement for
    /// (`aiSharingGate`), which runs `proceed` only after "Agree and continue".
    func gate(_ path: AISharingPath, _ proceed: @escaping @MainActor () -> Void) -> AISharingRequest? {
        if isAgreed {
            proceed()
            return nil
        }
        AppLog.info("ai_sharing_asked path=\(path.rawValue) agreedVersion=\(agreedVersion)")
        return AISharingRequest(path: path, proceed: proceed)
    }
}

/// Something waiting on the agreement: what it is, and what to do once agreed.
struct AISharingRequest: Identifiable {
    let id = UUID()
    let path: AISharingPath
    let proceed: @MainActor () -> Void
}

/// The agreement's words. Plain and short; they name the third party (Google Cloud) and what is sent. The
/// Privacy Policy (apps/site/src/pages/privacy.astro) says the providers' terms don't let them train on it.
/// Changing them means bumping `AISharingConsent.version`.
enum AISharingCopy {
    static let title = "Send your recordings to Google Cloud AI?"
    static let body = "To transcribe and summarise, AlgoMinutes sends your audio and its text to Google Cloud's speech and AI services (Gemini). Documents you scan and questions you ask about your notes go there too."
    static let detail = "Google doesn't use it to train its models. You can delete a note at any time, and turn this off in Settings."
    static let agree = "Agree and continue"
    static let notNow = "Not now"

    /// When something was stopped because the agreement isn't there.
    static let blocked = "Nothing was sent. AlgoMinutes needs your OK to send this to Google Cloud AI: turn it on in Settings, under Google Cloud AI."
    static let searchNeedsAgreement = "Only titles were searched. Searching what was said uses Google Cloud AI: turn it on in Settings, under Google Cloud AI."
    static let recordingHeld = "Your recording is kept on this iPhone and isn't uploaded until you agree to send it to Google Cloud AI (Settings, under Google Cloud AI)."

    // Settings.
    static let settingsTitle = "Google Cloud AI"
    static let settingsOn = "On. Your audio, scans and questions are sent to Google Cloud's speech and AI services (Gemini) to transcribe and summarise them."
    static let settingsOff = "Off. Nothing new is sent to Google Cloud AI: new recordings, imports, scans and questions wait until you agree again. Recordings stay on this iPhone meanwhile."
    static let withdraw = "Turn off"
    static let withdrawConfirm = "Stop sending"
    static let turnOn = "Turn on"
    static let withdrawTitle = "Stop sending to Google Cloud AI?"
    static let withdrawMessage = "Nothing new is uploaded, transcribed or summarised until you agree again. Notes already in your account stay there until you delete them."
}
