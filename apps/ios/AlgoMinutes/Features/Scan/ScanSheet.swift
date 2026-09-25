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
            }
            .padding(24)
        }
        .background(Theme.surface)
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
        defer { busyLabel = nil }
        do {
            var texts: [String] = []
            for image in images {
                texts.append(try await ScanService.recognizeText(in: image))
            }
            let combined = texts.joined(separator: "\n\n")
            let jpegData = images.first.flatMap { $0.jpegData(compressionQuality: 0.85) }
            await createTextNote(
                text: combined,
                source: .scannedImage,
                sourceData: jpegData,
                sourceExt: "jpg",
                sourceMime: "image/jpeg",
                fallbackTitle: nil
            )
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Could not read that image. Please try again."
        }
    }

    private func extractDocument(_ pickedURL: URL) async {
        busyLabel = "Reading document…"
        errorMessage = nil
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
            // Read the source bytes off the main actor — files can be large.
            let sourceData = await Task.detached(priority: .utility) { try? Data(contentsOf: localURL) }.value
            await createTextNote(
                text: extraction.text,
                source: extraction.source,
                sourceData: sourceData,
                sourceExt: localURL.pathExtension.lowercased(),
                sourceMime: UTType(filenameExtension: localURL.pathExtension.lowercased())?.preferredMIMEType ?? "application/octet-stream",
                fallbackTitle: fileTitle.isEmpty ? nil : fileTitle
            )
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Could not extract text from that file."
        }
    }

    /// Parity with processDocumentTextFile + finalizeExtractedTextNote.
    private func createTextNote(
        text: String,
        source: TextNoteBuilder.SourceKind,
        sourceData: Data?,
        sourceExt: String,
        sourceMime: String,
        fallbackTitle: String?
    ) async {
        guard let wsId = env.auth.workspaceId else { return }
        let placeholder = fallbackTitle ?? "Import \(AppEnvironment.dateStamp())"
        let built = TextNoteBuilder.build(text: text, source: source)

        let noteId: String
        do {
            noteId = try env.notes.createNote(fields: [
                "title": built.title ?? placeholder,
                "status": NoteStatus.ready.rawValue,
                "type": NoteType.scanText.rawValue,
                "duration": 0,
                "rawText": built.rawText,
                "wordCount": built.wordCount,
                "transcriptTruncated": built.transcriptTruncated,
                "transcript": built.transcript.map { ["speaker": $0.speaker, "text": $0.text, "time": $0.time] },
                "summary": [
                    "gist": built.gist,
                    "actionItems": [String](),
                    "keyDecisions": [String](),
                ],
            ])
        } catch {
            errorMessage = "Could not save the scan. Please try again."
            return
        }

        // The source image isn't uploaded: the note is its text. (It used to go to
        // Firebase's default bucket, which account deletion never purged.)

        onDone(noteId)
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
