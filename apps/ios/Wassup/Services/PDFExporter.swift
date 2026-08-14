import Foundation
import UIKit

/// PDF export — replicates the jsPDF layout in `generatePDF`
/// (`src/App.tsx`): A4 portrait, 20 mm margins, Title → Executive Summary →
/// Extracted Text (if any) → Action Items → Key Decisions, and now an
/// optional transcript.
///
/// Every export ends with the redaction notice. Transcript text is redacted
/// before it is stored, so the `<<REDACTED:…>>` markers in this document are
/// permanent — the user should learn that here rather than from a colleague
/// reading a forwarded copy.
enum PDFExporter {
    // A4 at 72 dpi; jsPDF layout is in mm — convert (1 mm = 2.8346 pt).
    private static let mm: CGFloat = 2.8346
    private static let pageRect = CGRect(x: 0, y: 0, width: 210 * 2.8346, height: 297 * 2.8346)

    static func fileName(for note: Note) -> String {
        var sanitized = note.title.map { ch -> Character in
            (ch.isLetter || ch.isNumber || ch == "-" || ch == "_") ? ch : "_"
        }
        if sanitized.count > 80 { sanitized = Array(sanitized.prefix(80)) }
        return String(sanitized) + "_Summary.pdf"
    }

    static func export(
        note: Note,
        scope: ExportScope = .summary,
        transcript: [TranscriptLine] = []
    ) -> Data {
        let renderer = UIGraphicsPDFRenderer(bounds: pageRect)
        return renderer.pdfData { ctx in
            var cursor = Cursor(ctx: ctx)
            cursor.begin()

            cursor.draw(text: note.title, font: .boldSystemFont(ofSize: 20), lineSpacing: 4)
            cursor.space(6 * mm)

            if scope.includesSummary {
            cursor.draw(text: "Executive Summary", font: .boldSystemFont(ofSize: 14), lineSpacing: 3)
            cursor.space(2 * mm)
            let gist = note.summary?.gist.isEmpty == false ? note.summary!.gist : "No summary."
            cursor.draw(text: gist, font: .systemFont(ofSize: 11), lineSpacing: 3)

            if let raw = note.rawText, !raw.isEmpty {
                cursor.space(6 * mm)
                cursor.draw(text: "Extracted Text", font: .boldSystemFont(ofSize: 14), lineSpacing: 3)
                cursor.space(2 * mm)
                cursor.draw(text: raw, font: .systemFont(ofSize: 10), lineSpacing: 2)
            }

            if let items = note.summary?.actionItems, !items.isEmpty {
                cursor.space(6 * mm)
                cursor.draw(text: "Action Items", font: .boldSystemFont(ofSize: 14), lineSpacing: 3)
                cursor.space(2 * mm)
                for item in items {
                    cursor.draw(text: "- \(item)", font: .systemFont(ofSize: 11), lineSpacing: 3, indent: 2 * mm)
                }
            }

            if let decisions = note.summary?.keyDecisions, !decisions.isEmpty {
                cursor.space(6 * mm)
                cursor.draw(text: "Key Decisions", font: .boldSystemFont(ofSize: 14), lineSpacing: 3)
                cursor.space(2 * mm)
                for decision in decisions {
                    cursor.draw(text: "- \(decision)", font: .systemFont(ofSize: 11), lineSpacing: 3, indent: 2 * mm)
                }
            }
            } // scope.includesSummary

            if scope.includesTranscript, !transcript.isEmpty {
                cursor.space(6 * mm)
                cursor.draw(text: "Transcript", font: .boldSystemFont(ofSize: 14), lineSpacing: 3)
                cursor.space(2 * mm)
                for line in transcript {
                    let prefix = [line.time, line.speaker]
                        .filter { !$0.isEmpty }
                        .joined(separator: "  ")
                    let body = prefix.isEmpty ? line.text : "[\(prefix)] \(line.text)"
                    cursor.draw(text: body, font: .systemFont(ofSize: 10), lineSpacing: 2)
                }
            }

            cursor.space(8 * mm)
            cursor.draw(text: NoteExport.redactionNotice, font: .systemFont(ofSize: 8), lineSpacing: 2)
        }
    }

    private struct Cursor {
        let ctx: UIGraphicsPDFRendererContext
        var y: CGFloat = 22 * PDFExporter.mm
        let left: CGFloat = 20 * PDFExporter.mm
        let width: CGFloat = 170 * PDFExporter.mm
        let bottom: CGFloat = PDFExporter.pageRect.height - 20 * PDFExporter.mm

        mutating func begin() {
            ctx.beginPage()
        }

        mutating func space(_ amount: CGFloat) {
            y += amount
        }

        mutating func draw(text: String, font: UIFont, lineSpacing: CGFloat, indent: CGFloat = 0) {
            let paragraphStyle = NSMutableParagraphStyle()
            paragraphStyle.lineSpacing = lineSpacing
            let attributes: [NSAttributedString.Key: Any] = [
                .font: font,
                .foregroundColor: UIColor.black,
                .paragraphStyle: paragraphStyle,
            ]
            // Draw line-wrapped, paginating when a chunk would overflow.
            let attributed = NSAttributedString(string: text, attributes: attributes)
            let framesetter = CTFramesetterCreateWithAttributedString(attributed)
            var rangeStart = 0
            let length = attributed.length
            while rangeStart < length {
                if y > bottom - font.lineHeight {
                    ctx.beginPage()
                    y = 20 * PDFExporter.mm
                }
                let available = CGSize(width: width - indent, height: bottom - y)
                var fitRange = CFRange()
                CTFramesetterSuggestFrameSizeWithConstraints(
                    framesetter,
                    CFRange(location: rangeStart, length: 0),
                    nil,
                    available,
                    &fitRange
                )
                if fitRange.length == 0 { break }
                let path = CGPath(
                    rect: CGRect(x: left + indent, y: PDFExporter.pageRect.height - y - available.height, width: width - indent, height: available.height),
                    transform: nil
                )
                let frame = CTFramesetterCreateFrame(framesetter, CFRange(location: rangeStart, length: fitRange.length), path, nil)
                let cgCtx = ctx.cgContext
                cgCtx.saveGState()
                cgCtx.textMatrix = .identity
                cgCtx.translateBy(x: 0, y: PDFExporter.pageRect.height)
                cgCtx.scaleBy(x: 1, y: -1)
                CTFrameDraw(frame, cgCtx)
                cgCtx.restoreGState()

                let drawn = CTFramesetterSuggestFrameSizeWithConstraints(
                    framesetter,
                    CFRange(location: rangeStart, length: fitRange.length),
                    nil,
                    CGSize(width: width - indent, height: .greatestFiniteMagnitude),
                    nil
                )
                y += drawn.height
                rangeStart += fitRange.length
                if rangeStart < length {
                    ctx.beginPage()
                    y = 20 * PDFExporter.mm
                }
            }
        }
    }
}
