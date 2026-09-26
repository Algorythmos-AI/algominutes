import SwiftUI
import UniformTypeIdentifiers

/// Audio-file import (parity with `ImportPanel.tsx`, unified to the dark theme;
/// see DEVIATIONS.md). The web's YouTube import isn't offered on iOS: importing
/// another service's videos is an App Review risk (guideline 5.2.3). Notes made
/// from YouTube on the web still show here.
struct ImportSheet: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let onDone: (String?) -> Void

    @State private var showFilePicker = false
    @State private var errorMessage: String?
    @State private var warnMessage: String?
    @State private var isUploading = false
    @State private var uploadPercent = 0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("Import Files")
                    .font(Typography.heading(22, weight: .bold))
                    .foregroundStyle(Theme.heading)

                // MARK: Audio file
                AlgoMinutesCard {
                    VStack(alignment: .leading, spacing: 12) {
                        Label("Audio file", systemImage: "waveform")
                            .font(Typography.heading(16, weight: .bold))
                            .foregroundStyle(Theme.heading)
                        Text("MP3, M4A, WAV and more, up to 500 MB.")
                            .font(Typography.body(13))
                            .foregroundStyle(Theme.muted)
                        if isUploading {
                            ProgressView(value: Double(uploadPercent), total: 100) {
                                Text("Uploading… \(uploadPercent)%")
                                    .font(Typography.body(13))
                                    .foregroundStyle(Theme.body)
                            }
                            .tint(Theme.outline)
                        } else {
                            Button("Choose audio file") { showFilePicker = true }
                                .buttonStyle(PrimaryButtonStyle())
                        }
                    }
                }

                if let warn = warnMessage {
                    Label(warn, systemImage: "info.circle")
                        .font(Typography.body(13))
                        .foregroundStyle(Theme.body)
                }
                if let error = errorMessage {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(Typography.body(13))
                        .foregroundStyle(Theme.heading)
                }
            }
            .padding(24)
        }
        .background(Theme.surface)
        .fileImporter(
            isPresented: $showFilePicker,
            allowedContentTypes: [.audio, .mpeg4Audio, .mp3, .wav, .aiff, .movie],
            allowsMultipleSelection: false
        ) { result in
            if case .success(let urls) = result, let url = urls.first {
                Task { await importAudioFile(url) }
            }
        }
    }

    // MARK: - Audio file import (parity with ImportPanel)

    private func importAudioFile(_ pickedURL: URL) async {
        errorMessage = nil
        warnMessage = nil

        let secured = pickedURL.startAccessingSecurityScopedResource()
        defer { if secured { pickedURL.stopAccessingSecurityScopedResource() } }

        // Copy into our sandbox so the upload outlives the picker grant.
        let localURL = FileManager.default.temporaryDirectory.appendingPathComponent(
            "import_\(Int(Date().timeIntervalSince1970 * 1000)).\(pickedURL.pathExtension.isEmpty ? "m4a" : pickedURL.pathExtension)"
        )
        do {
            try? FileManager.default.removeItem(at: localURL)
            try FileManager.default.copyItem(at: pickedURL, to: localURL)
        } catch {
            errorMessage = "Could not read that file. Please try again."
            return
        }

        let size = (try? FileManager.default.attributesOfItem(atPath: localURL.path)[.size] as? Int64) ?? 0
        let sizeMB = Int(size / (1024 * 1024))
        if size >= StorageKind.importFile.maxBytes {
            errorMessage = "That file is \(sizeMB) MB. The current limit is 500 MB."
            try? FileManager.default.removeItem(at: localURL)
            return
        }
        if size >= StoragePaths.importSoftWarnBytes {
            warnMessage = "Heads up — \(sizeMB) MB will take a while to upload and process."
        }

        isUploading = true
        defer { isUploading = false }

        let ext = localURL.pathExtension.lowercased()
        let mimeType = Self.mimeType(forExtension: ext)
        var createdNoteId: String?
        await env.uploadAndProcess(
            fileURL: localURL,
            mimeType: mimeType,
            ext: ext,
            type: .importAudio,
            kind: .importFile,
            durationSeconds: nil,
            initialStatus: .queued,
            onNoteCreated: { id in createdNoteId = id }
        )
        try? FileManager.default.removeItem(at: localURL)
        onDone(createdNoteId)
    }

    private static func mimeType(forExtension ext: String) -> String {
        UTType(filenameExtension: ext)?.preferredMIMEType ?? "audio/mpeg"
    }
}
