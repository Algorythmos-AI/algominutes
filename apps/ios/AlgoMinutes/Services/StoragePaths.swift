import Foundation

/// Upload path + size-cap rules. Every upload goes through `/v1/uploads`, which
/// refuses anything over 500 MB (services/api uploads.js, `MAX_AUDIO_BYTES`), so
/// that is the one cap the app checks before it starts.
enum StorageKind {
    case recording   // recordings/{ws}/{noteId}.{ext}
    case importFile  // imports/{ws}/{noteId}.{ext}
    case scan        // scans/{ws}/{noteId}.{ext}

    var prefix: String {
        switch self {
        case .recording: return "recordings"
        case .importFile: return "imports"
        case .scan: return "scans"
        }
    }

    /// The server's cap, for every kind.
    var maxBytes: Int64 { Self.serverMaxBytes }
    static let serverMaxBytes: Int64 = 500 * 1024 * 1024
    static let serverMaxLabel = "500 MB"
}

enum StoragePaths {
    static func path(kind: StorageKind, workspaceId: String, noteId: String, ext: String) -> String {
        "\(kind.prefix)/\(workspaceId)/\(noteId).\(ext)"
    }

    /// Soft warning threshold for imports (parity with ImportPanel).
    static let importSoftWarnBytes: Int64 = 100 * 1024 * 1024
}

func workspaceId(forUid uid: String) -> String {
    "workspace_\(uid)"
}
