import Foundation
import PDFKit
import UIKit
import Vision

enum ScanError: LocalizedError {
    case unreadableImage
    case unsupportedType(String)
    case legacyDoc

    var errorDescription: String? {
        switch self {
        case .unreadableImage:
            return "Could not read that image. Please try another one."
        case .unsupportedType(let ext):
            return "Unsupported file type (.\(ext)). Try an image, PDF, or TXT file."
        case .legacyDoc:
            return "Legacy .doc files are not supported yet. Please convert to PDF or plain text first."
        }
    }
}

/// Text extraction — Vision OCR replaces Tesseract.js; PDFKit replaces
/// pdfjs-dist. DOCX is intentionally unsupported in iOS v1 (see DEVIATIONS).
enum ScanService {
    static let pdfOcrFallbackMaxPages = 6

    // MARK: - OCR

    static func recognizeText(in image: UIImage) async throws -> String {
        guard let cgImage = image.cgImage else { throw ScanError.unreadableImage }
        return try await withCheckedThrowingContinuation { continuation in
            let request = VNRecognizeTextRequest { request, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
                let lines = observations.compactMap { $0.topCandidates(1).first?.string }
                continuation.resume(returning: lines.joined(separator: "\n"))
            }
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    try VNImageRequestHandler(cgImage: cgImage).perform([request])
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    // MARK: - Document text extraction (parity with src/lib/documentText.ts)

    struct Extraction {
        var text: String
        var source: TextNoteBuilder.SourceKind
    }

    static func extractText(fromFileAt url: URL) async throws -> Extraction {
        let ext = url.pathExtension.lowercased()
        switch ext {
        case "jpg", "jpeg", "png", "heic", "heif", "webp", "gif", "tiff", "bmp":
            guard let image = UIImage(contentsOfFile: url.path) else { throw ScanError.unreadableImage }
            return Extraction(text: try await recognizeText(in: image), source: .scannedImage)
        case "pdf":
            return Extraction(text: try await extractPdfText(url: url), source: .pdf)
        case "txt", "md", "csv":
            let text = (try? String(contentsOf: url, encoding: .utf8))
                ?? String(decoding: (try? Data(contentsOf: url)) ?? Data(), as: UTF8.self)
            return Extraction(text: text, source: .imported)
        case "doc", "docx":
            throw ScanError.legacyDoc
        default:
            throw ScanError.unsupportedType(ext)
        }
    }

    /// PDFKit text layer; per-page OCR fallback for scanned PDFs (≤ 6 pages).
    static func extractPdfText(url: URL) async throws -> String {
        guard let document = PDFDocument(url: url) else { throw ScanError.unreadableImage }
        var pages: [String] = []
        for index in 0..<document.pageCount {
            guard let page = document.page(at: index) else { continue }
            let text = page.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if text.isEmpty, document.pageCount <= pdfOcrFallbackMaxPages {
                let image = renderPage(page, scale: 2)
                pages.append((try? await recognizeText(in: image)) ?? "")
            } else {
                pages.append(text)
            }
        }
        return pages.joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func renderPage(_ page: PDFPage, scale: CGFloat) -> UIImage {
        let bounds = page.bounds(for: .mediaBox)
        let size = CGSize(width: bounds.width * scale, height: bounds.height * scale)
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
            ctx.cgContext.translateBy(x: 0, y: size.height)
            ctx.cgContext.scaleBy(x: scale, y: -scale)
            page.draw(with: .mediaBox, to: ctx.cgContext)
        }
    }

    // MARK: - Images → PDF (parity with src/lib/imagePdf.ts)

    static let maxImagesPerPdf = 30

    /// A4 pages, 28 pt margins, images fit-centered.
    static func buildPdf(images: [UIImage]) -> Data {
        let pageRect = CGRect(x: 0, y: 0, width: 595.28, height: 841.89) // A4 in pt
        let margin: CGFloat = 28
        let contentRect = pageRect.insetBy(dx: margin, dy: margin)
        let renderer = UIGraphicsPDFRenderer(bounds: pageRect)
        return renderer.pdfData { ctx in
            for image in images.prefix(maxImagesPerPdf) {
                ctx.beginPage()
                let size = image.size
                guard size.width > 0, size.height > 0 else { continue }
                let ratio = min(contentRect.width / size.width, contentRect.height / size.height, 1)
                let drawSize = CGSize(width: size.width * ratio, height: size.height * ratio)
                let origin = CGPoint(
                    x: contentRect.midX - drawSize.width / 2,
                    y: contentRect.midY - drawSize.height / 2
                )
                image.draw(in: CGRect(origin: origin, size: drawSize))
            }
        }
    }
}
