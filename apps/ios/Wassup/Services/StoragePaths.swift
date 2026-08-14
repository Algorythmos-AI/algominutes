import Foundation

/// Upload path + size-cap rules, mirroring `storage.rules`.
enum StorageKind {
    case recording   // recordings/{ws}/{noteId}.{ext}  — < 120 MB, audio/*
    case importFile  // imports/{ws}/{noteId}.{ext}     — < 500 MB
    case scan        // scans/{ws}/{noteId}.{ext}       — < 50 MB

    var prefix: String {
        switch self {
        case .recording: return "recordings"
        case .importFile: return "imports"
        case .scan: return "scans"
        }
    }

    var maxBytes: Int64 {
        switch self {
        case .recording, .scan: return 50 * 1024 * 1024
        case .importFile: return 500 * 1024 * 1024
        }
    }
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
