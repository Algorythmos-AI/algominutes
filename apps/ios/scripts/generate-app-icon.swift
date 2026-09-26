#!/usr/bin/env swift
// The AlgoMinutes brand renderer: the "ai" mark, drawn once from measured
// geometry, in every form the app and the site use. Pure CoreGraphics, so the
// output doesn't drift across OS releases.
//
// Usage (from apps/ios): swift scripts/generate-app-icon.swift
// Writes:
//   AlgoMinutes/Resources/Assets.xcassets/AppIcon.appiconset/
//     AppIcon-1024.png         opaque gradient tile (App Store rejects alpha here)
//     AppIcon-1024-dark.png    the mark on transparent (iOS composites its dark tile)
//     AppIcon-1024-tinted.png  greyscale on transparent (iOS applies the user's tint)
//   AlgoMinutes/Resources/Assets.xcassets/Logo.imageset/logo.pdf
//                            the rounded tile as a vector (the in-app logo)
//   brand/icon.svg           the square tile (1024)
//   brand/icon-rounded.svg   the rounded tile, for the web and documents
//   brand/mark-on-dark.svg   the mark alone, for dark backgrounds
//   brand/mark-on-light.svg  the mark alone, for light backgrounds
//
// Colours come from packages/tokens/tokens.json (brand.mark), which were sampled
// from the owner's artwork (brand/reference/). The geometry below was measured
// from the same artwork (brand/README.md) and is in a 1024 x 1024 tile, y down.

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// MARK: - Geometry (1024 tile, origin top-left)

struct Circle { let cx, cy, r: CGFloat }

enum Mark {
    /// The "a" bowl: a disc...
    static let bowl = Circle(cx: 486.9, cy: 566.9, r: 171.4)
    /// ...with a round counter...
    static let counter = Circle(cx: 493.7, cy: 566.9, r: 73.1)
    /// ...an "i" stem, flush with the bowl's base...
    static let stem = CGRect(x: 592.0, y: 413.7, width: 82.3, height: 324.6)
    /// ...a speech-bubble tail off the bowl's lower left...
    static let tail = [CGPoint(x: 346.5, y: 667.4), CGPoint(x: 404.6, y: 720.0), CGPoint(x: 306.3, y: 756.6)]
    /// ...and the "i" dot, in the lighter colour.
    static let dot = Circle(cx: 649.1, cy: 310.9, r: 52.6)
    /// The rounded tile's corner (iOS masks the square icon itself).
    static let cornerRadius: CGFloat = 229
}

let tile: CGFloat = 1024

// MARK: - Colours (packages/tokens/tokens.json brand.mark)

struct RGB {
    let r, g, b: CGFloat
    let hex: String
    init(_ hex: String) {
        var v: UInt64 = 0
        Scanner(string: hex.replacingOccurrences(of: "#", with: "")).scanHexInt64(&v)
        r = CGFloat((v >> 16) & 0xFF) / 255; g = CGFloat((v >> 8) & 0xFF) / 255; b = CGFloat(v & 0xFF) / 255
        self.hex = hex.uppercased()
    }
    var cg: CGColor { CGColor(srgbRed: r, green: g, blue: b, alpha: 1) }
}

let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()   // apps/ios/scripts
let ios = here.deletingLastPathComponent()                               // apps/ios
let tokensURL = ios.appendingPathComponent("../../packages/tokens/tokens.json").standardizedFileURL
let tokens = try! JSONSerialization.jsonObject(with: Data(contentsOf: tokensURL)) as! [String: Any]
let mark = (tokens["brand"] as! [String: Any])["mark"] as! [String: String]
func color(_ key: String) -> RGB {
    guard let hex = mark[key] else { fatalError("tokens.json brand.mark.\(key) is missing") }
    return RGB(hex)
}
let gradientStart = color("gradientStart"), gradientEnd = color("gradientEnd")
let glyph = color("glyph"), dotColor = color("dot"), dotOnLight = color("dotOnLight")

let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

// MARK: - Drawing

/// Flip to top-left origin, so the geometry reads as measured.
func flip(_ ctx: CGContext, height: CGFloat) {
    ctx.translateBy(x: 0, y: height)
    ctx.scaleBy(x: 1, y: -1)
}

func addCircle(_ ctx: CGContext, _ c: Circle) {
    ctx.addEllipse(in: CGRect(x: c.cx - c.r, y: c.cy - c.r, width: 2 * c.r, height: 2 * c.r))
}

func drawGradient(_ ctx: CGContext) {
    let g = CGGradient(colorsSpace: srgb, colors: [gradientStart.cg, gradientEnd.cg] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(g, start: .zero, end: CGPoint(x: tile, y: tile), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
}

enum Counter { case gradient, transparent }

/// The mark: glyph, counter, dot. Each shape is filled on its own (no path
/// winding to get wrong); the counter is re-painted with the tile's gradient or
/// cleared.
func drawMark(_ ctx: CGContext, glyphColor: CGColor, dot: CGColor, counter: Counter) {
    ctx.saveGState()
    ctx.setFillColor(glyphColor)
    addCircle(ctx, Mark.bowl); ctx.fillPath()
    ctx.addRect(Mark.stem); ctx.fillPath()
    ctx.move(to: Mark.tail[0]); ctx.addLine(to: Mark.tail[1]); ctx.addLine(to: Mark.tail[2]); ctx.closePath(); ctx.fillPath()
    switch counter {
    case .gradient:
        ctx.saveGState(); addCircle(ctx, Mark.counter); ctx.clip(); drawGradient(ctx); ctx.restoreGState()
    case .transparent:
        ctx.saveGState(); ctx.setBlendMode(.clear); addCircle(ctx, Mark.counter); ctx.fillPath(); ctx.restoreGState()
    }
    ctx.setFillColor(dot)
    addCircle(ctx, Mark.dot); ctx.fillPath()
    ctx.restoreGState()
}

func bitmap(opaque: Bool) -> CGContext {
    // Opaque (no alpha channel) for the primary icon: App Store validation
    // rejects alpha there. The variants keep alpha.
    let info: CGImageAlphaInfo = opaque ? .noneSkipLast : .premultipliedLast
    let ctx = CGContext(data: nil, width: Int(tile), height: Int(tile), bitsPerComponent: 8, bytesPerRow: 0,
                        space: srgb, bitmapInfo: info.rawValue)!
    flip(ctx, height: tile)
    return ctx
}

func writePNG(_ ctx: CGContext, _ url: URL) {
    let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
    guard CGImageDestinationFinalize(dest) else { fatalError("failed writing \(url.path)") }
    print("wrote \(url.path.replacingOccurrences(of: ios.path + "/", with: ""))")
}

// MARK: - App icons

let appIcon = ios.appendingPathComponent("AlgoMinutes/Resources/Assets.xcassets/AppIcon.appiconset")

let primary = bitmap(opaque: true)
drawGradient(primary)
drawMark(primary, glyphColor: glyph.cg, dot: dotColor.cg, counter: .gradient)
writePNG(primary, appIcon.appendingPathComponent("AppIcon-1024.png"))

let dark = bitmap(opaque: false)
drawMark(dark, glyphColor: glyph.cg, dot: dotColor.cg, counter: .transparent)
writePNG(dark, appIcon.appendingPathComponent("AppIcon-1024-dark.png"))

// Tinted: greyscale, the dot a step darker so the "i" still reads.
let tinted = bitmap(opaque: false)
drawMark(tinted, glyphColor: CGColor(gray: 1, alpha: 1), dot: CGColor(gray: 0.82, alpha: 1), counter: .transparent)
writePNG(tinted, appIcon.appendingPathComponent("AppIcon-1024-tinted.png"))

// MARK: - In-app logo (vector PDF)

let logoURL = ios.appendingPathComponent("AlgoMinutes/Resources/Assets.xcassets/Logo.imageset/logo.pdf")
var box = CGRect(x: 0, y: 0, width: 96, height: 96)   // points; the asset scales as a vector
let pdf = CGContext(logoURL as CFURL, mediaBox: &box, nil)!
pdf.beginPDFPage(nil)
flip(pdf, height: box.height)
pdf.scaleBy(x: box.width / tile, y: box.height / tile)
pdf.addPath(CGPath(roundedRect: CGRect(x: 0, y: 0, width: tile, height: tile),
                   cornerWidth: Mark.cornerRadius, cornerHeight: Mark.cornerRadius, transform: nil))
pdf.clip()
drawGradient(pdf)
drawMark(pdf, glyphColor: glyph.cg, dot: dotColor.cg, counter: .gradient)
pdf.endPDFPage()
pdf.closePDF()
print("wrote \(logoURL.path.replacingOccurrences(of: ios.path + "/", with: ""))")

// MARK: - SVG (the same geometry, for the web and documents)

func n(_ v: CGFloat) -> String {
    let s = String(format: "%.1f", Double(v))
    return s.hasSuffix(".0") ? String(s.dropLast(2)) : s
}
func svgCircle(_ c: Circle, _ attrs: String) -> String { "<circle cx=\"\(n(c.cx))\" cy=\"\(n(c.cy))\" r=\"\(n(c.r))\" \(attrs)/>" }
let svgStem = "<rect x=\"\(n(Mark.stem.minX))\" y=\"\(n(Mark.stem.minY))\" width=\"\(n(Mark.stem.width))\" height=\"\(n(Mark.stem.height))\""
let svgTail = "<polygon points=\"" + Mark.tail.map { "\(n($0.x)),\(n($0.y))" }.joined(separator: " ") + "\""
let gradientDef = """
  <linearGradient id="tile" x1="0" y1="0" x2="\(n(tile))" y2="\(n(tile))" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="\(gradientStart.hex)"/>
    <stop offset="1" stop-color="\(gradientEnd.hex)"/>
  </linearGradient>
"""
/// The glyph with its counter cut out, as a mask (no winding rules involved).
let glyphMask = """
  <mask id="glyph" maskUnits="userSpaceOnUse" x="0" y="0" width="\(n(tile))" height="\(n(tile))">
    \(svgCircle(Mark.bowl, "fill=\"#fff\""))
    \(svgStem) fill="#fff"/>
    \(svgTail) fill="#fff"/>
    \(svgCircle(Mark.counter, "fill=\"#000\""))
  </mask>
"""
func svg(title: String, defs: String, body: String) -> String {
    """
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 \(n(tile)) \(n(tile))" width="\(n(tile))" height="\(n(tile))">
      <title>\(title)</title>
      <!-- Generated by apps/ios/scripts/generate-app-icon.swift from packages/tokens/tokens.json (brand.mark). Don't edit by hand. -->
      <defs>
    \(defs)
      </defs>
    \(body)
    </svg>

    """
}
func writeText(_ text: String, _ path: String) {
    let url = ios.appendingPathComponent(path)
    try! FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try! text.write(to: url, atomically: true, encoding: .utf8)
    print("wrote \(path)")
}
let markBody = { (glyphHex: String, dotHex: String) in
    """
      <rect width="\(n(tile))" height="\(n(tile))" fill="\(glyphHex)" mask="url(#glyph)"/>
      \(svgCircle(Mark.dot, "fill=\"\(dotHex)\""))
    """
}
writeText(svg(title: "AlgoMinutes", defs: gradientDef + glyphMask,
              body: "  <rect width=\"\(n(tile))\" height=\"\(n(tile))\" fill=\"url(#tile)\"/>\n" + markBody(glyph.hex, dotColor.hex)),
          "brand/icon.svg")
writeText(svg(title: "AlgoMinutes", defs: gradientDef + glyphMask,
              body: "  <rect width=\"\(n(tile))\" height=\"\(n(tile))\" rx=\"\(n(Mark.cornerRadius))\" fill=\"url(#tile)\"/>\n" + markBody(glyph.hex, dotColor.hex)),
          "brand/icon-rounded.svg")
writeText(svg(title: "AlgoMinutes mark (on dark)", defs: glyphMask, body: markBody(glyph.hex, dotColor.hex)), "brand/mark-on-dark.svg")
writeText(svg(title: "AlgoMinutes mark (on light)", defs: glyphMask, body: markBody(gradientStart.hex, dotOnLight.hex)), "brand/mark-on-light.svg")
