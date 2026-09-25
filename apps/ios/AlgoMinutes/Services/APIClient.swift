import Foundation
import FirebaseAuth

/// Export-specific failures the UI can act on, as opposed to a raw HTTP code.
enum ExportError: LocalizedError {
    /// The server's 20k-line guard. DOCX rendering a transcript that long
    /// costs more memory than it is worth; the caller falls back to TXT.
    case transcriptTooLarge

    var errorDescription: String? {
        switch self {
        case .transcriptTooLarge:
            return "This transcript is too long for a Word document. Exporting as text instead."
        }
    }
}

enum APIError: LocalizedError {
    case notSignedIn
    case http(status: Int, message: String?)
    case invalidResponse
    /// A9.4: the server refused a metered action because the user is out of
    /// quota (HTTP 402, `error: "quota_exceeded"`). Modelled as its own case so
    /// callers can present the paywall instead of surfacing a raw 402 alert.
    /// Carries the entitlement from the 402 body, when it had one.
    case quotaExceeded(EntitlementResponse?)
    /// This app version is below the server's minimum (HTTP 426, `please_update`).
    case updateRequired

    var errorDescription: String? {
        switch self {
        case .notSignedIn: return "Not signed in"
        case .http(let status, let message): return message ?? "Request failed (\(status))"
        case .invalidResponse: return "Invalid server response"
        case .quotaExceeded: return "You've used up your included minutes. Upgrade to keep going."
        case .updateRequired: return "Please update AlgoMinutes to continue."
        }
    }
}

/// HTTPS client for the AlgoMinutes backend. The origin is the build
/// configuration's (AppConfig: Debug and Staging → staging, Release → prod).
final class APIClient: Sendable {
    static let baseURL = AppConfig.apiBaseURL
    /// The billing service's own host (/v1/purchases/verify).
    static let billingBaseURL = AppConfig.billingBaseURL

    /// Every /v1 request names the client and its version; the api answers 400
    /// without it and 426 below its minimum (services/api client-version.js).
    static let clientHeader = "X-AlgoMinutes-Client"
    static var clientHeaderValue: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
        return "ios/\(version)"
    }

    private let session: URLSession
    private let tokenProvider: @Sendable () async throws -> String

    /// `session` and `idToken` are injectable for tests (URLProtocol stubs, no Firebase).
    init(session: URLSession? = nil, idToken: (@Sendable () async throws -> String)? = nil) {
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.default
            // Parity with authedFetch's CapacitorHttp timeouts.
            config.timeoutIntervalForRequest = 20
            config.timeoutIntervalForResource = 300
            self.session = URLSession(configuration: config)
        }
        self.tokenProvider = idToken ?? {
            guard let user = Auth.auth().currentUser else { throw APIError.notSignedIn }
            return try await user.getIDToken()
        }
    }

    private func idToken() async throws -> String {
        try await tokenProvider()
    }

    private func request(
        path: String,
        method: String = "POST",
        body: [String: Any]? = [:],
        accept: String = "application/json",
        base: URL = APIClient.baseURL
    ) async throws -> URLRequest {
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.httpMethod = method
        req.setValue(accept, forHTTPHeaderField: "Accept")
        req.setValue(Self.clientHeaderValue, forHTTPHeaderField: Self.clientHeader)
        req.setValue("Bearer \(try await idToken())", forHTTPHeaderField: "Authorization")
        if method != "GET", let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return req
    }

    /// The typed error for a non-2xx answer: a spent quota (402, with the
    /// entitlement it carries) and an app too old for the server (426) get
    /// their own cases.
    static func httpError(status: Int, json: [String: Any]?) -> Error {
        let code = json?["error"] as? String
        if isQuota(status: status, error: code) { return APIError.quotaExceeded(entitlement(in: json)) }
        if status == 426 { return updateRequired() }
        return APIError.http(status: status, message: code)
    }

    /// Any endpoint's 426 raises the update screen (AppEnvironment observes
    /// this), so an outdated app says so wherever it first hits the server.
    static func updateRequired() -> APIError {
        NotificationCenter.default.post(name: .algoMinutesUpdateRequired, object: nil)
        return APIError.updateRequired
    }

    /// The 402 body's `entitlement` (EntitlementResponse), or nil.
    private static func entitlement(in json: [String: Any]?) -> EntitlementResponse? {
        guard let raw = json?["entitlement"] as? [String: Any],
              let data = try? JSONSerialization.data(withJSONObject: raw)
        else { return nil }
        return try? JSONDecoder().decode(EntitlementResponse.self, from: data)
    }

    private func post(path: String, body: [String: Any]) async throws -> [String: Any] {
        let req = try await request(path: path, body: body)
        return try await perform(req)
    }

    /// Send a prepared request and decode the JSON dictionary, mapping the
    /// shared error cases (quota, non-2xx). Extracted so `processAudio` can
    /// build a request, inject the device-attestation headers, and reuse the
    /// exact same send/parse path as `post`.
    private func perform(_ req: URLRequest) async throws -> [String: Any] {
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        guard (200..<300).contains(http.statusCode) else {
            throw Self.httpError(status: http.statusCode, json: json)
        }
        return json ?? [:]
    }

    /// A9.4: the server signals an exhausted quota with 402 + `quota_exceeded`.
    /// Centralised so every endpoint maps it to the same typed error.
    private static func isQuota(status: Int, error: String?) -> Bool {
        status == 402 && error == "quota_exceeded"
    }

    /// Send a prepared request and decode the body into a `Decodable` rather
    /// than a dictionary (the typed upload, entitlement and purchase endpoints).
    private func sendDecoded<T: Decodable>(_ req: URLRequest) async throws -> T {
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw Self.httpError(status: http.statusCode, json: (try? JSONSerialization.jsonObject(with: data)) as? [String: Any])
        }
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw APIError.invalidResponse }
    }

    private func postDecoded<T: Decodable>(path: String, body: [String: Any], base: URL = APIClient.baseURL) async throws -> T {
        try await sendDecoded(try await request(path: path, body: body, base: base))
    }

    private func getDecoded<T: Decodable>(path: String) async throws -> T {
        try await sendDecoded(try await request(path: path, method: "GET", body: nil))
    }

    // MARK: - Endpoints

    struct ProcessAudioRequest {
        var noteId: String
        var workspaceId: String
        var type: NoteType
        var storagePath: String?
        var sourceUrl: String?
        var mimeType: String?
        /// Kept for the caller's own bookkeeping (the Firestore doc); not part
        /// of ProcessRequest, so it isn't sent.
        var retryAttempt: Int?
        /// The recording's length: the quota check meters on it (ProcessRequest).
        var durationSec: Double?
    }

    @discardableResult
    func processAudio(_ r: ProcessAudioRequest) async throws -> [String: Any] {
        var body: [String: Any] = [
            "noteId": r.noteId,
            "workspaceId": r.workspaceId,
            "type": r.type.rawValue,
        ]
        if let p = r.storagePath { body["storagePath"] = p }
        if let u = r.sourceUrl { body["sourceUrl"] = u }
        if let m = r.mimeType { body["mimeType"] = m }
        if let d = r.durationSec, d > 0 { body["durationSec"] = d }

        // A10 #7: the process request is the trial kickoff. Bind it to the
        // device with a DeviceCheck token so the server (which hashes it into
        // trial_device_hash) can refuse a second fresh trial from the same
        // device. Best-effort: an absent token just omits the header, and the
        // server falls back to account-level trial checks.
        // TODO(A4-apple): server-side DeviceCheck validation needs the Apple
        // DeviceCheck key configured; the client half is wired here.
        var req = try await request(path: "v1/process", body: body)
        req.setValue(DeviceAttestationService.platformHeaderValue, forHTTPHeaderField: "X-Device-Platform")
        if let token = await DeviceAttestationService.attestationToken() {
            req.setValue(token, forHTTPHeaderField: "X-Device-Attestation")
        }
        return try await perform(req)
    }

    // MARK: - Resumable upload session (A7.2)
    //
    // Mirrors CreateUploadSession{Request,Response}, UploadSessionStatus and
    // CompleteUploadResponse in `packages/contracts/src/schemas/async.ts`. Field
    // names match the contract exactly. The server creates a GCS resumable
    // session; BackgroundUploadService PUTs chunks to `sessionUri` directly.
    //
    // Routes: POST /v1/uploads, GET /v1/uploads/{id}, POST /v1/uploads/{id}/complete.

    struct CreateUploadSessionResponse: Decodable, Sendable {
        let uploadId: String
        /// Opaque resumable-session URI the client PUTs chunks to directly.
        let sessionUri: String
        let storagePath: String
        let chunkSize: Int
        let expiresAt: String
    }

    struct UploadSessionStatus: Decodable, Sendable {
        let uploadId: String
        let receivedBytes: Int64
        let complete: Bool
    }

    struct CompleteUploadResponse: Decodable, Sendable {
        let uploadId: String
        let storagePath: String
        let complete: Bool
    }

    func createUploadSession(
        noteId: String,
        workspaceId: String,
        fileName: String,
        contentType: String,
        totalBytes: Int64,
        sha256: String? = nil
    ) async throws -> CreateUploadSessionResponse {
        var body: [String: Any] = [
            "noteId": noteId,
            "workspaceId": workspaceId,
            "fileName": fileName,
            "contentType": contentType,
            "totalBytes": totalBytes,
        ]
        if let sha256 { body["sha256"] = sha256 }
        return try await postDecoded(path: "v1/uploads", body: body)
    }

    /// How many bytes the server already holds — the client's resume anchor.
    func uploadSessionStatus(uploadId: String) async throws -> UploadSessionStatus {
        try await getDecoded(path: "v1/uploads/\(uploadId)")
    }

    /// Finalise a fully-transferred session before kicking off processing.
    @discardableResult
    func completeUpload(uploadId: String) async throws -> CompleteUploadResponse {
        try await postDecoded(path: "v1/uploads/\(uploadId)/complete", body: [:])
    }

    // MARK: - Push registration (A7.3)
    //
    // Mirrors RegisterPushTokenRequest in the async contract. `platform` is fixed
    // to "ios"; the token is an FCM registration token (APNs via FCM).
    @discardableResult
    func registerPushToken(
        token: String,
        platform: String = "ios",
        appVersion: String? = nil
    ) async throws -> [String: Any] {
        var body: [String: Any] = ["token": token, "platform": platform]
        if let appVersion { body["appVersion"] = appVersion }
        return try await post(path: "v1/push/register", body: body)
    }

    func search(query: String, k: Int = 12) async throws -> [SearchHit] {
        let json = try await post(path: "v1/search", body: ["query": query, "k": k])
        guard let hitsRaw = json["hits"],
              let data = try? JSONSerialization.data(withJSONObject: hitsRaw) else {
            return []
        }
        return (try? JSONDecoder().decode([SearchHit].self, from: data)) ?? []
    }

    @discardableResult
    func deleteAccount() async throws -> [String: Any] {
        try await post(path: "v1/account/delete", body: [:])
    }

    /// A short-lived signed URL (15 minutes) to play a note's audio
    /// (POST /v1/notes/audio-url). Clients never read the recordings bucket
    /// directly. Don't log or persist the URL: it is a capability until it expires.
    func noteAudioURL(noteId: String, workspaceId: String) async throws -> URL {
        let json = try await post(path: "v1/notes/audio-url", body: ["noteId": noteId, "workspaceId": workspaceId])
        guard let raw = json["url"] as? String, let url = URL(string: raw), url.scheme == "https" else {
            throw APIError.invalidResponse
        }
        return url
    }

    /// Delete a note: Postgres first, then its Firestore doc, then its audio
    /// (POST /v1/notes/delete). Clients can't delete note docs directly (the
    /// Firestore rules refuse it). Returns whether a Postgres row went.
    @discardableResult
    func deleteNote(noteId: String, workspaceId: String) async throws -> Bool {
        let json = try await post(path: "v1/notes/delete", body: ["noteId": noteId, "workspaceId": workspaceId])
        return (json["deleted"] as? Bool) ?? false
    }

    /// Persist a manual note edit.
    ///
    /// Goes through `/v1/notes/update` rather than writing Firestore directly,
    /// because Postgres is the system of record: an edit written only to the
    /// Firestore cache leaves `/v1/search` and `/v1/chat` serving the
    /// pre-edit text. The endpoint writes Postgres first, then mirrors.
    ///
    /// Live since PR #58 and, until now, called by nothing on iOS.
    @discardableResult
    func updateNote(
        noteId: String,
        workspaceId: String,
        title: String? = nil,
        summary: Summary? = nil
    ) async throws -> [String: Any] {
        var body: [String: Any] = ["noteId": noteId, "workspaceId": workspaceId]
        if let title { body["title"] = title }
        if let summary {
            var s: [String: Any] = [
                "gist": summary.gist,
                "actionItems": summary.actionItems,
                "keyDecisions": summary.keyDecisions,
            ]
            if let keyPoints = summary.keyPoints { s["keyPoints"] = keyPoints }
            body["summary"] = s
        }
        return try await post(path: "v1/notes/update", body: body)
    }

    /// Save a transcription-quality rating.
    ///
    /// One rating per user per note: the server upserts on that key, so
    /// rating again corrects the previous value rather than adding a row.
    /// Any free-text comment is PII-redacted server-side before storage.
    @discardableResult
    func submitFeedback(
        noteId: String,
        workspaceId: String,
        rating: Int,
        comment: String? = nil
    ) async throws -> [String: Any] {
        var body: [String: Any] = ["noteId": noteId, "workspaceId": workspaceId, "rating": rating]
        if let comment, !comment.isEmpty { body["comment"] = comment }
        return try await post(path: "v1/notes/feedback", body: body)
    }

    /// Name a diarised speaker (ADR 0005). Renaming "Speaker 2" → a name updates
    /// the per-note note_speakers map server-side; the next transcript read
    /// resolves every line for that tag to the new name. An empty `name` clears
    /// the mapping (reverts to "Speaker N"). The server gates the write by
    /// workspace membership. Returns the raw JSON (`{ ok, noteId, speakers }`).
    @discardableResult
    func setNoteSpeaker(
        noteId: String,
        workspaceId: String,
        speakerTag: Int,
        name: String
    ) async throws -> [String: Any] {
        let body: [String: Any] = [
            "workspaceId": workspaceId,
            "speakerTag": speakerTag,
            "name": name,
        ]
        return try await post(path: "v1/notes/\(noteId)/speakers", body: body)
    }

    /// Why a regenerate was refused.
    ///
    /// The server answers 409 for two different reasons and the UI must not
    /// confuse them: one is a transient "wait", the other destroys the user's
    /// own edits unless they confirm. Modelled as a type so a caller cannot
    /// accidentally treat them alike by string-matching.
    enum RegenerateConflict: Error {
        /// A regenerate is already running, or the note is still processing.
        case alreadyRegenerating(status: String?)
        /// The summary was hand-edited. Retry with `confirmOverwrite: true`
        /// only after the user has agreed to lose those edits.
        case manualEdits(editedAt: String?)
    }

    /// Re-run the summarizer over an existing transcript.
    ///
    /// Returns the new generation number on success. Throws
    /// `RegenerateConflict` for either 409, and `APIError` otherwise.
    @discardableResult
    func regenerateSummary(
        noteId: String,
        workspaceId: String,
        template: String? = nil,
        confirmOverwrite: Bool = false
    ) async throws -> Int {
        var body: [String: Any] = ["noteId": noteId, "workspaceId": workspaceId]
        if let template { body["template"] = template }
        if confirmOverwrite { body["confirmOverwrite"] = true }

        let req = try await request(path: "v1/notes/regenerate-summary", body: body)
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]

        if http.statusCode == 409 {
            // Branch on the server's error code, not on prose — the copy can
            // change without the meaning changing.
            if (json?["error"] as? String) == "manual_edits_present" {
                throw RegenerateConflict.manualEdits(editedAt: json?["editedAt"] as? String)
            }
            throw RegenerateConflict.alreadyRegenerating(status: json?["status"] as? String)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw Self.httpError(status: http.statusCode, json: json)
        }
        return json?["generation"] as? Int ?? 0
    }

    /// A minted share link. `url` is the only time the token is visible.
    struct ShareLink: Sendable {
        let shareId: String
        let url: String
        let expiresAt: String?
    }

    /// Create a public read link for a note.
    ///
    /// The returned URL contains the raw token and is the single moment it
    /// exists in the clear — the server stores only its hash. Do not log it,
    /// and do not persist it anywhere the user did not ask for.
    func createShareLink(
        noteId: String,
        workspaceId: String,
        scope: ExportScope = .both,
        expiresInHours: Int? = nil
    ) async throws -> ShareLink {
        var body: [String: Any] = [
            "noteId": noteId, "workspaceId": workspaceId, "scope": scope.rawValue,
        ]
        if let expiresInHours { body["expiresInHours"] = expiresInHours }
        let json = try await post(path: "v1/shares/create", body: body)
        guard let url = json["url"] as? String, let id = json["shareId"] as? String else {
            throw APIError.invalidResponse
        }
        return ShareLink(shareId: id, url: url, expiresAt: json["expiresAt"] as? String)
    }

    /// Revoke a link. Idempotent server-side, so retrying is safe.
    @discardableResult
    func revokeShareLink(noteId: String, workspaceId: String, shareId: String) async throws -> Bool {
        let json = try await post(
            path: "v1/shares/revoke",
            body: ["noteId": noteId, "workspaceId": workspaceId, "shareId": shareId],
        )
        return (json["revoked"] as? Bool) ?? true
    }

    /// Server-rendered DOCX for a note.
    ///
    /// Returns raw bytes rather than JSON — the server deliberately does not
    /// mint a signed URL, which would be a second unauthenticated egress
    /// surface for a file the caller is already authenticated for.
    ///
    /// Throws `.transcriptTooLarge` on the server's 20k-line guard so the
    /// caller can fall back to TXT instead of surfacing a raw 413.
    func exportNote(
        noteId: String,
        workspaceId: String,
        scope: ExportScope
    ) async throws -> Data {
        let body: [String: Any] = [
            "noteId": noteId, "workspaceId": workspaceId,
            "format": "docx", "scope": scope.rawValue,
        ]
        // Ask for the binary explicitly; the default Accept is JSON.
        let req = try await request(
            path: "v1/export", body: body,
            accept: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        )
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            if http.statusCode == 413 { throw ExportError.transcriptTooLarge }
            throw Self.httpError(status: http.statusCode, json: json)
        }
        return data
    }

    /// One page of a note's full transcript from Postgres.
    ///
    /// Paged because a two-hour meeting is thousands of lines; the caller
    /// follows `nextCursor` until it is nil. Uses `data(for:)` directly rather
    /// than `post(_:)` because the response needs real decoding, not a
    /// dictionary.
    func fetchTranscriptPage(
        noteId: String,
        workspaceId: String,
        cursor: String? = nil,
        limit: Int? = nil
    ) async throws -> TranscriptPageResponse.Transcript {
        var body: [String: Any] = ["noteId": noteId, "workspaceId": workspaceId]
        if let cursor { body["cursor"] = cursor }
        if let limit { body["limit"] = limit }

        let req = try await request(path: "v1/notes/read", body: body)
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw Self.httpError(status: http.statusCode, json: (try? JSONSerialization.jsonObject(with: data)) as? [String: Any])
        }
        return try JSONDecoder().decode(TranscriptPageResponse.self, from: data).transcript
    }

    /// Streams `/v1/chat`. The stream finishes on `done`, throws on transport
    /// failure, and surfaces server-sent errors as `.serverError` events.
    ///
    /// Passing `noteId` scopes retrieval to that note —
    /// the server treats it as an additional filter on top of workspace
    /// membership, and answers 404 for a note this user cannot reach.
    func chatStream(query: String, noteId: String? = nil) -> AsyncThrowingStream<ChatStreamEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var req = try await self.request(
                        path: "v1/chat",
                        body: noteId.map { ["query": query, "noteId": $0] } ?? ["query": query],
                        accept: "text/event-stream"
                    )
                    // Chat streams can exceed the default request timeout.
                    req.timeoutInterval = 180

                    let (bytes, response) = try await self.session.bytes(for: req)
                    guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
                    guard http.statusCode == 200 else {
                        var body = Data()
                        for try await byte in bytes { body.append(byte) }
                        let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
                        if http.statusCode == 426 { throw APIClient.updateRequired() }
                        throw APIError.http(status: http.statusCode, message: json?["error"] as? String ?? "Chat failed (\(http.statusCode))")
                    }

                    // Raw byte reads: blank lines are the SSE frame delimiter and
                    // must reach the parser intact. Flushing only at 0x0A is
                    // UTF-8 safe (continuation bytes are >= 0x80).
                    var parser = SSEParser()
                    var pending = Data()
                    for try await byte in bytes {
                        pending.append(byte)
                        guard byte == 0x0A else { continue }
                        guard let chunk = String(data: pending, encoding: .utf8) else { continue }
                        pending.removeAll(keepingCapacity: true)
                        for event in parser.feed(chunk) {
                            continuation.yield(event)
                            if case .done = event {
                                continuation.finish()
                                return
                            }
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: - A10 compliance (terms, retention, support)
    //
    // Field names mirror packages/contracts/src/schemas/compliance.ts exactly:
    //   AcceptTermsRequest, SetRetentionRequest, SupportRequest.

    /// A10 #3: record timestamped acceptance of the Terms + Privacy Policy at
    /// signup. The server stamps the time and stores (uid, versions). Idempotent
    /// — safe to re-post; the caller only calls it when the accepted version has
    /// changed. `platform` is fixed to "ios".
    @discardableResult
    func acceptTerms(
        termsVersion: String,
        privacyVersion: String,
        appVersion: String? = nil
    ) async throws -> [String: Any] {
        var body: [String: Any] = [
            "termsVersion": termsVersion,
            "privacyVersion": privacyVersion,
            "platform": "ios",
        ]
        if let appVersion { body["appVersion"] = appVersion }
        return try await post(path: "v1/account/accept-terms", body: body)
    }

    /// A10 #5: set the note-retention window. `days == nil` means "keep until I
    /// delete" (sent as JSON null, which the contract's nullable field accepts).
    @discardableResult
    func setRetention(days: Int?) async throws -> [String: Any] {
        let body: [String: Any] = ["retentionDays": days ?? NSNull()]
        return try await post(path: "v1/account/retention", body: body)
    }

    /// A10 #4 support kinds. Mirrors SupportRequest.kind.
    enum SupportKind: String {
        case contact
        case badTranscript = "bad_transcript"
        case badSummary = "bad_summary"
    }

    /// A10 #4: submit a support / feedback request with diagnostic context ONLY.
    ///
    /// NEVER attaches audio or transcript — `noteId` is a reference the server
    /// uses to look up its own logs, not content the client uploads
    /// (docs/STORE-COMPLIANCE.md §1). `appVersion`/`device` are non-sensitive
    /// diagnostics.
    @discardableResult
    func submitSupport(
        kind: SupportKind,
        message: String? = nil,
        noteId: String? = nil,
        appVersion: String? = nil,
        device: String? = nil
    ) async throws -> [String: Any] {
        var body: [String: Any] = ["kind": kind.rawValue, "platform": "ios"]
        if let message, !message.isEmpty { body["message"] = message }
        if let noteId { body["noteId"] = noteId }
        if let appVersion { body["appVersion"] = appVersion }
        if let device { body["device"] = device }
        return try await post(path: "v1/support", body: body)
    }

    // MARK: - Billing (A9.4) + analytics (A9.6)
    //
    // Field names mirror packages/contracts/src/schemas/billing.ts exactly:
    //   VerifyPurchaseRequest / VerifyPurchaseResponse, TrackEventRequest, and
    //   async.ts EntitlementResponse. Entitlement is granted ONLY by the server
    //   from a validated receipt — the client posts the StoreKit JWS and reads
    //   back the resolved state; it never self-grants.
    //
    // Purchases go to the billing service's own host; entitlement and events
    // are the api's.

    /// Validate a StoreKit 2 signed transaction (JWS) server-side. On success the
    /// server activates the entitlement keyed to the current user and echoes the
    /// resolved state. Mirrors `VerifyPurchaseRequest` (rail: apple_storekit).
    func verifyPurchase(jws: String) async throws -> VerifyPurchaseResponse {
        try await postDecoded(
            path: "v1/purchases/verify",
            body: ["rail": "apple_storekit", "jwsRepresentation": jws],
            base: Self.billingBaseURL
        )
    }

    /// Read the server-resolved entitlement (A9.1). This is the ONLY source of
    /// truth for trial/active/free_floor state and the trial countdown.
    func fetchEntitlement() async throws -> EntitlementResponse {
        try await getDecoded(path: "v1/entitlement")
    }

    /// A9.6 funnel event. Best-effort: analytics must never block a user action,
    /// so callers wrap this in `try?`. Mirrors `TrackEventRequest`.
    @discardableResult
    func track(
        event: AnalyticsEvent,
        props: [String: Any]? = nil
    ) async throws -> [String: Any] {
        var body: [String: Any] = ["event": event.rawValue]
        if let props, !props.isEmpty { body["props"] = props }
        // Client stamps the moment; the server overrides if it prefers its clock.
        body["occurredAt"] = ISO8601DateFormatter.entitlement.string(from: Date())
        return try await post(path: "v1/events", body: body)
    }
}

extension Notification.Name {
    /// Posted when the api answers 426: this build is below its minimum.
    static let algoMinutesUpdateRequired = Notification.Name("AlgoMinutesUpdateRequired")
}
