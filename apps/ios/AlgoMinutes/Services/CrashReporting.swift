import CryptoKit
import FirebaseCore
import FirebaseCrashlytics
import Foundation

/// What Crashlytics learns beyond crashes (RELEASE.md rev 11, H15).
///
/// - Its user id is a hash of the signed-in uid, not the uid: reports can be
///   grouped per user (how many users a failure hit) without carrying an id that
///   names an account.
/// - A note the pipeline failed is a non-fatal, by its diagnostic code, so a rise
///   in failures shows in the same place as crashes. No title, transcript or
///   message: only the code.
///
/// Nothing is sent from a Debug build, as with AppLog.
enum CrashReporting {
    /// The first 16 hex digits of SHA-256(uid): stable for a user, not reversible to the uid.
    static func hashedUserId(_ uid: String) -> String {
        SHA256.hash(data: Data(uid.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    static func userChanged(uid: String?) {
        #if !DEBUG
        guard FirebaseApp.app() != nil else { return }
        Crashlytics.crashlytics().setUserID(uid.map(hashedUserId) ?? "")
        #endif
    }

    static func noteFailed(diagnosticCode: String?) {
        let code = diagnosticCode ?? "none"
        AppLog.error("pipeline_note_failed code=\(code)")
        #if !DEBUG
        guard FirebaseApp.app() != nil else { return }
        Crashlytics.crashlytics().record(error: NSError(domain: "Pipeline.noteFailed", code: 0, userInfo: ["diagnostic_code": code]))
        #endif
    }
}
