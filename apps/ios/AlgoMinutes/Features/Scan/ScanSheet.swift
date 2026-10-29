import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import VisionKit

/// Scan text menu — parity with `ScanPanel.tsx`: scan image → text, read
/// document text, photo(s) → PDF. Camera uses VisionKit's document scanner.
struct ScanSheet: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let onDone: (String?) -> Void

    private enum Mode { case scanTextCamera, pdfCamera }
    @State private var cameraMode: Mode?
    @State private var showDocPicker = false
    @State private var photoPickerPurpose: Mode?
    @State private var photoSelections: [PhotosPickerItem] = []
    @State private var busyLabel: String?
    @State private var errorMessage: String?
    @State private var shareItem: ShareItem?
    /// The text of a save that failed, kept so Try again sends the same note (no offline queue in 1.0).
    @State private var pendingSave: PendingTextNote?
    /// A save waiting on the Google Cloud AI agreement (App Store 5.1.2(i)). "Not now" keeps the text here.
    @State private var aiSharingRequest: AISharingRequest?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Scan text")
                        .font(Typography.heading(22, weight: .bold))
                        .foregroundStyle(Theme.heading)
                    Text("Images, PDF, TXT")
                        .font(Typography.body(13))
                        .foregroundStyle(Theme.muted)
                }

                if let busy = busyLabel {
                    AlgoMinutesCard {
                        HStack(spacing: 12) {
                            ProgressView().tint(Theme.outline)
                            Text(busy)
                                .font(Typography.body(14))
                                .foregroundStyle(Theme.body)
                        }
                    }
                }

                Menu {
                    Button("Take Photo") { cameraMode = .scanTextCamera }
                    Button("Choose from Library") { photoPickerPurpose = .scanTextCamera }
                } label: {
                    rowLabel(icon: "text.viewfinder", title: "Scan image to text", subtitle: "Camera or photo library")
                }

                Button {
                    showDocPicker = true
                } label: {
                    rowLabel(icon: "doc.text", title: "Read document text", subtitle: "PDF, TXT, MD, CSV, image")
                }
                .buttonStyle(.plain)

                Menu {
                    Button("Take Photos") { cameraMode = .pdfCamera }
                    Button("Choose from Library") { photoPickerPurpose = .pdfCamera }
                } label: {
                    rowLabel(icon: "doc.richtext", title: "Photos to PDF", subtitle: "Pick one or more pages")
                }

                if let error = errorMessage {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(Typography.body(13))
                        .foregroundStyle(Theme.heading)
                }

                if let pending = pendingSave, busyLabel == nil {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Your text is kept here until you close this.")
                            .font(Typography.body(12))
                            .foregroundStyle(Theme.muted)
                        // No error: it's waiting on the Google Cloud AI agreement, not a failed save.
                        Button(errorMessage == nil ? "Save as a note" : "Try again") {
                            Task { await save(pending) }
                        }
                        .font(Typography.heading(15, weight: .bold))
                        .accessibilityIdentifier("scan.saveAgain")
                    }
                }
            }
            .padding(24)
        }
        .background(Theme.surface)
        .aiSharingGate($aiSharingRequest, consent: env.aiSharing)
        .fullScreenCover(item: Binding(
            get: { cameraMode.map { CameraSession(mode: $0) } },
            set: { if $0 == nil { cameraMode = nil } }
        )) { session in
            DocumentCameraView { images in
                cameraMode = nil
                guard !images.isEmpty else { return }
                switch session.mode {
                case .scanTextCamera:
                    Task { await ocrImages(images) }
                case .pdfCamera:
                    Task { await buildPdf(from: images) }
                }
            }
            .ignoresSafeArea()
        }
        .photosPicker(
            isPresented: Binding(
                get: { photoPickerPurpose != nil },
                set: { if !$0 { photoPickerPurpose = nil } }
            ),
            selection: $photoSelections,
            maxSelectionCount: photoPickerPurpose == .pdfCamera ? ScanService.maxImagesPerPdf : 1,
            matching: .images
        )
        .onChange(of: photoSelections) { _, items in
            guard !items.isEmpty, let purpose = photoPickerPurpose else { return }
            photoPickerPurpose = nil
            photoSelections = []
            Task {
                let images = await loadImages(items)
                guard !images.isEmpty else {
                    errorMessage = "Choose image files only."
                    return
                }
                switch purpose {
                case .scanTextCamera: await ocrImages(images)
                case .pdfCamera: await buildPdf(from: images)
                }
            }
        }
        .fileImporter(
            isPresented: $showDocPicker,
            allowedContentTypes: [.pdf, .plainText, .image, UTType(filenameExtension: "md") ?? .plainText, .commaSeparatedText],
            allowsMultipleSelection: false
        ) { result in
            if case .success(let urls) = result, let url = urls.first {
                Task { await extractDocument(url) }
            }
        }
        .sheet(item: $shareItem) { item in
            ActivityShareSheet(items: item.items)
        }
    }

    private struct CameraSession: Identifiable {
        let mode: Mode
        var id: String { mode == .scanTextCamera ? "scan" : "pdf" }
    }

    private func rowLabel(icon: String, title: String, subtitle: String) -> some View {
        AlgoMinutesCard {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(Theme.onInverse)
                    .frame(width: 48, height: 48)
                    .background(
                        RoundedRectangle(cornerRadius: 14)
                            .fill(Theme.inverse)
                    )
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(Typography.heading(15, weight: .bold))
                        .foregroundStyle(Theme.heading)
                    Text(subtitle)
                        .font(Typography.body(12))
                        .foregroundStyle(Theme.muted)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.tertiary)
            }
        }
    }

    // MARK: - Flows

    private func loadImages(_ items: [PhotosPickerItem]) async -> [UIImage] {
        var images: [UIImage] = []
        for item in items {
            if let data = try? await item.loadTransferable(type: Data.self),
               let image = UIImage(data: data) {
                images.append(image)
            }
        }
        return images
    }

    private func ocrImages(_ images: [UIImage]) async {
        busyLabel = "Reading text…"
        errorMessage = nil
        pendingSave = nil
        defer { busyLabel = nil }
        do {
            var texts: [String] = []
            for image in images {
                texts.append(try await ScanService.recognizeText(in: image))
            }
            let combined = texts.joined(separator: "\n\n")
            await createTextNote(text: combined, source: .scannedImage, fallbackTitle: nil)
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Could not read that image. Please try again."
        }
    }

    private func extractDocument(_ pickedURL: URL) async {
        busyLabel = "Reading document…"
        errorMessage = nil
        pendingSave = nil
        defer { busyLabel = nil }

        let secured = pickedURL.startAccessingSecurityScopedResource()
        defer { if secured { pickedURL.stopAccessingSecurityScopedResource() } }

        let localURL = FileManager.default.temporaryDirectory.appendingPathComponent(pickedURL.lastPathComponent)
        try? FileManager.default.removeItem(at: localURL)
        do {
            try FileManager.default.copyItem(at: pickedURL, to: localURL)
        } catch {
            errorMessage = "Could not read that file. Please try again."
            return
        }
        defer { try? FileManager.default.removeItem(at: localURL) }

        do {
            let extraction = try await ScanService.extractText(fromFileAt: localURL)
            let fileTitle = localURL.deletingPathExtension().lastPathComponent
            await createTextNote(text: extraction.text, source: extraction.source, fallbackTitle: fileTitle.isEmpty ? nil : fileTitle)
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Could not extract text from that file."
        }
    }

    /// Saved by the server (POST /v1/notes/text): Postgres first, then the doc the note list reads, so the note is
    /// inside retention, backups, search and export like every other note. The server builds it from the text.
    /// The source file isn't uploaded: the note is its text.
    private func createTextNote(text: String, source: TextNoteSource, fallbackTitle: String?) async {
        guard let wsId = env.auth.workspaceId else { return }
        await save(PendingTextNote(workspaceId: wsId, text: text, source: source, title: fallbackTitle))
    }

    private func save(_ note: PendingTextNote) async {
        // The text goes to Google Cloud AI to be summarised: asked first. Until then it's kept here, unsent.
        guard env.aiSharing.isAgreed else {
            errorMessage = nil
            pendingSave = note
            aiSharingRequest = env.aiSharing.gate(.scan) { Task { await save(note) } }
            return
        }
        busyLabel = "Saving…"
        errorMessage = nil
        defer { busyLabel = nil }
        switch await TextNoteSave.save(note, api: env.api, aiSharingAgreed: env.aiSharing.allows(.scan)) {
        case .saved(let noteId):
            pendingSave = nil
            onDone(noteId)
        case .notAgreed:
            pendingSave = note
        case .failed(let message, let retry):
            AppLog.error("text_note_save_failed: \(message)")
            errorMessage = message
            pendingSave = retry
        }
    }

    private func buildPdf(from images: [UIImage]) async {
        busyLabel = "Building PDF..."
        errorMessage = nil
        defer { busyLabel = nil }

        let data = ScanService.buildPdf(images: images)
        let name = "Scan_\(AppEnvironment.dateStamp()).pdf"
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        do {
            try data.write(to: url)
            shareItem = ShareItem(items: [url])
        } catch {
            errorMessage = "Could not create the PDF. Please try again."
        }
    }
}

// MARK: - VisionKit document camera

struct DocumentCameraView: UIViewControllerRepresentable {
    let onFinish: ([UIImage]) -> Void

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let controller = VNDocumentCameraViewController()
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ uiViewController: VNDocumentCameraViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let onFinish: ([UIImage]) -> Void
        init(onFinish: @escaping ([UIImage]) -> Void) { self.onFinish = onFinish }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            var images: [UIImage] = []
            for index in 0..<scan.pageCount {
                images.append(scan.imageOfPage(at: index))
            }
            onFinish(images)
        }

        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            onFinish([])
        }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
            onFinish([])
        }
    }
}
