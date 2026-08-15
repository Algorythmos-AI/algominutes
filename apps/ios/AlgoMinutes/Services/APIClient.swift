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
    case quotaExceeded

    var errorDescription: String? {
        switch self {
        case .notSignedIn: return "Not signed in"
        case .http(let status, let message): return message ?? "Request failed (\(status))"
        case .invalidResponse: return "Invalid server response"
        case .quotaExceeded: return "You've used up your included minutes. Upgrade to keep going."
        }
    }
}

/// HTTPS client for the AlgoMinutes backend.
/// TODO(A9-infra): api.algominutes.com is the target origin; confirm it is live
/// (the web client still points at the old hosting origin until infra lands).
final class APIClient: Sendable {
    static let baseURL = URL(string: "https://api.algominutes.com")!

    private let session: URLSession

    init() {
        let config = URLSessionConfiguration.default
        // Parity with authedFetch's CapacitorHttp timeouts.
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 300
        session = URLSession(configuration: config)
    }

    private func idToken() async throws -> String {
        guard let user = Auth.auth().currentUser else { throw APIError.notSignedIn }
        return try await user.getIDToken()
    }

    private func request(path: String, body: [String: Any], accept: String = "application/json") async throws -> URLRequest {
        var req = URLRequest(url: Self.baseURL.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(accept, forHTTPHeaderField: "Accept")
        req.setValue("Bearer \(try await idToken())", forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        return req
    }

    private func post(path: String, body: [String: Any]) async throws -> [String: Any] {
        let req = try await request(path: path, body: body)
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        guard (200..<300).contains(http.statusCode) else {
            if Self.isQuota(status: http.statusCode, error: json?["error"] as? String) {
                throw APIError.quotaExceeded
            }
            throw APIError.http(status: http.statusCode, message: json?["error"] as? String)
        }
        return json ?? [:]
    }

    /// A9.4: the server signals an exhausted quota with 402 + `quota_exceeded`.
    /// Centralised so every endpoint maps it to the same typed error.
    private static func isQuota(status: Int, error: String?) -> Bool {
        status == 402 && error == "quota_exceeded"
    }

    /// `post` variant that decodes the body into a `Decodable` rather than a
    /// dictionary — used by the typed A7.2 upload-session endpoints.
    private func postDecoded<T: Decodable>(path: String, body: [String: Any]) async throws -> T {
        let req = try await request(path: path, body: body)
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            if Self.isQuota(status: http.statusCode, error: json?["error"] as? String) {
                throw APIError.quotaExceeded
            }
            throw APIError.http(status: http.statusCode, message: json?["error"] as? String)
        }
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw APIError.invalidResponse }
    }

    // MARK: - Endpoints

    struct ProcessAudioRequest {
        var noteId: String
        var workspaceId: String
        var type: NoteType
        var storagePath: String?
        var sourceUrl: String?
        var mimeType: String?
        var retryAttempt: Int?
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
        if let a = r.retryAttempt { body["retryAttempt"] = a }
        return try await post(path: "api/process-audio", body: body)
    }

    // MARK: - Resumable upload session (A7.2)
    //
    // Mirrors CreateUploadSession{Request,Response}, UploadSessionStatus and
    // CompleteUploadResponse in `packages/contracts/src/schemas/async.ts`. Field
    // names match the contract exactly. The server creates a GCS resumable
    // session; BackgroundUploadService PUTs chunks to `sessionUri` directly.
    //
    // TODO(A7.2): these endpoints are not built server-side yet — the paths below
    // are provisional and the feature is gated OFF (see AppFeatureFlags). Confirm
    // the routes when the backend lands.

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
        return try await postDecoded(path: "api/upload-session-create", body: body)
    }

    /// How many bytes the server already holds — the client's resume anchor.
    func uploadSessionStatus(uploadId: String) async throws -> UploadSessionStatus {
        try await postDecoded(path: "api/upload-session-status", body: ["uploadId": uploadId])
    }

    /// Finalise a fully-transferred session before kicking off processing.
    @discardableResult
    func completeUpload(uploadId: String) async throws -> CompleteUploadResponse {
        try await postDecoded(path: "api/upload-session-complete", body: ["uploadId": uploadId])
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
        // TODO(A7.3): confirm the route when the notifier service lands.
        return try await post(path: "api/register-push-token", body: body)
    }

    func search(query: String, k: Int = 12) async throws -> [SearchHit] {
        let json = try await post(path: "api/search", body: ["query": query, "k": k])
        guard let hitsRaw = json["hits"],
              let data = try? JSONSerialization.data(withJSONObject: hitsRaw) else {
            return []
        }
        return (try? JSONDecoder().decode([SearchHit].self, from: data)) ?? []
    }

    @discardableResult
    func deleteAccount() async throws -> [String: Any] {
        try await post(path: "api/delete-account", body: [:])
    }

    /// Persist a manual note edit.
    ///
    /// Goes through `/api/update-note` rather than writing Firestore directly,
    /// because Postgres is the system of record: an edit written only to the
    /// Firestore cache leaves `/api/search` and `/api/chat` serving the
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
        return try await post(path: "api/update-note", body: body)
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
        return try await post(path: "api/note-feedback", body: body)
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

        let req = try await request(path: "api/regenerate-summary", body: body)
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
            throw APIError.http(status: http.statusCode, message: json?["error"] as? String)
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
        let json = try await post(path: "api/share-create", body: body)
        guard let url = json["url"] as? String, let id = json["shareId"] as? String else {
            throw APIError.invalidResponse
        }
        return ShareLink(shareId: id, url: url, expiresAt: json["expiresAt"] as? String)
    }

    /// Revoke a link. Idempotent server-side, so retrying is safe.
    @discardableResult
    func revokeShareLink(noteId: String, workspaceId: String, shareId: String) async throws -> Bool {
        let json = try await post(
            path: "api/share-revoke",
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
            path: "api/export-note", body: body,
            accept: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        )
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            if http.statusCode == 413 { throw ExportError.transcriptTooLarge }
            throw APIError.http(status: http.statusCode, message: json?["error"] as? String)
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

        let req = try await request(path: "api/note", body: body)
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw APIError.http(status: http.statusCode, message: json?["error"] as? String)
        }
        return try JSONDecoder().decode(TranscriptPageResponse.self, from: data).transcript
    }

    /// Streams `/api/chat`. The stream finishes on `done`, throws on transport
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
                        path: "api/chat",
                        body: noteId.map { ["query": query, "noteId": $0] } ?? ["query": query],
                        accept: "text/event-stream"
                    )
                    // Chat streams can exceed the default request timeout.
                    req.timeoutInterval = 180

                    let (bytes, response) = try await URLSession.shared.bytes(for: req)
                    guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
                    guard http.statusCode == 200 else {
                        var body = Data()
                        for try await byte in bytes { body.append(byte) }
                        let message = ((try? JSONSerialization.jsonObject(with: body)) as? [String: Any])?["error"] as? String
                        throw APIError.http(status: http.statusCode, message: message ?? "Chat failed (\(http.statusCode))")
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

    // MARK: - Billing (A9.4) + analytics (A9.6)
    //
    // Field names mirror packages/contracts/src/schemas/billing.ts exactly:
    //   VerifyPurchaseRequest / VerifyPurchaseResponse, TrackEventRequest, and
    //   async.ts EntitlementResponse. Entitlement is granted ONLY by the server
    //   from a validated receipt — the client posts the StoreKit JWS and reads
    //   back the resolved state; it never self-grants.
    //
    // TODO(A9-infra): confirm these routes when services/billing lands. Paths
    // follow the existing `api/*` convention except `track`, which the plan
    // pins to `/v1/events`.

    /// Validate a StoreKit 2 signed transaction (JWS) server-side. On success the
    /// server activates the entitlement keyed to the current user and echoes the
    /// resolved state. Mirrors `VerifyPurchaseRequest` (rail: apple_storekit).
    func verifyPurchase(jws: String) async throws -> VerifyPurchaseResponse {
        try await postDecoded(
            path: "api/verify-purchase",
            body: ["rail": "apple_storekit", "jwsRepresentation": jws]
        )
    }

    /// Read the server-resolved entitlement (A9.1). This is the ONLY source of
    /// truth for trial/active/free_floor state and the trial countdown.
    func fetchEntitlement() async throws -> EntitlementResponse {
        try await postDecoded(path: "api/entitlement", body: [:])
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
