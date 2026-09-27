#!/usr/bin/env swift
// The AlgoMinutes brand renderer: the "ai" mark, drawn once from measured
// geometry, in every form the apps and the site use. Pure CoreGraphics, so the
// output doesn't drift across OS releases.
//
// Usage (from the repo root, on a Mac): swift brand/scripts/generate.swift
// Writes:
//   apps/ios/AlgoMinutes/Resources/AppIcon.icon/   the app icon, an Icon Composer document:
//     icon.json, Assets/{background,background-dark}.png, Assets/{glyph,dot}.svg. iOS 26
//     renders it as Liquid Glass; Xcode 26 flattens it for iOS 17-25 and the App Store.
//   apps/ios/AlgoMinutes/Resources/Assets.xcassets/AppIcon.appiconset/   the same icon,
//     flattened, for an Xcode before 26 (which can't read .icon)
//   apps/ios/AlgoMinutes/Resources/Assets.xcassets/Logo.imageset/logo.pdf   the in-app logo
//   brand/icon/      the tile (SVG, square and rounded; PNGs; iOS renditions via ictool)
//   brand/logo/      the mark, the Geist wordmark and the lockups (SVG, text as outlines)
//   brand/social/profile-800.png   the avatar
//   brand/mark.json  the laid-out geometry (tests/brand-assets.test.ts checks the size)
//   apps/site/public/   favicon.svg, favicon.ico, apple-touch-icon.png
//   apps/web/public/    logo.svg, logo.png, favicon-16/32, icon-48…512, icon-maskable-192/512,
//                       apple-touch-icon.png
// brand/scripts/social.mjs then renders the PNGs of the logos and the social images.
//
// Colours come from packages/tokens/tokens.json (brand.mark). The geometry was
// measured from the owner's artwork (brand/README.md), in a 1024 tile, y down,
// and is laid out below: scaled ×1.75 and centred, so the mark fills 85% of the
// tile (docs/DECISIONS.md, 2026-09-27).

import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

// MARK: - Geometry (1024 tile, origin top-left)

struct Circle {
    let cx, cy, r: CGFloat
    var rect: CGRect { CGRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r) }
}

enum Mark {
    /// The "a" bowl: a disc...
    static let bowl = Circle(cx: 486.9, cy: 566.9, r: 171.4)
    /// ...with a round counter...
    static let counter = Circle(cx: 493.7, cy: 566.9, r: 73.1)
    /// ...an "i" stem, flush with the bowl's base...
    static let stem = CGRect(x: 592.0, y: 413.7, width: 82.3, height: 324.6)
    /// ...a speech-bubble tail off the bowl's lower left...
    static let tail = [CGPoint(x: 346.5, y: 667.4), CGPoint(x: 404.6, y: 720.0), CGPoint(x: 306.3, y: 756.6)]
    /// ...and the "i" dot.
    static let dot = Circle(cx: 649.1, cy: 310.9, r: 52.6)
    /// The rounded tile's corner (iOS masks the square icon itself).
    static let cornerRadius: CGFloat = 229
    /// The app icon's scale: the mark's bounding box, dot included, fills 85% of
    /// the tile's height.
    static let iconScale: CGFloat = 1.75
    /// A maskable web icon keeps everything inside the central 80% circle.
    static let maskableScale: CGFloat = 1.2
}

let tile: CGFloat = 1024

/// The glyph as one outline: bowl, stem and tail, less the counter.
let rawGlyph: CGPath = {
    let tail = CGMutablePath()
    tail.addLines(between: Mark.tail)
    tail.closeSubpath()
    return CGPath(ellipseIn: Mark.bowl.rect, transform: nil)
        .union(CGPath(rect: Mark.stem, transform: nil))
        .union(tail)
        .subtracting(CGPath(ellipseIn: Mark.counter.rect, transform: nil))
}()
let rawBounds = rawGlyph.boundingBoxOfPath.union(Mark.dot.rect)

/// The mark laid out in the tile: scaled about its bounding box's centre, and
/// centred.
struct Layout {
    let scale: CGFloat
    let glyph: CGPath
    let dot: Circle
    let bounds: CGRect
    let tailTip: CGPoint
    let transform: CGAffineTransform

    init(scale: CGFloat) {
        var t = CGAffineTransform(translationX: tile / 2, y: tile / 2)
            .scaledBy(x: scale, y: scale)
            .translatedBy(x: -rawBounds.midX, y: -rawBounds.midY)
        self.scale = scale
        self.transform = t
        glyph = rawGlyph.copy(using: &t)!
        let c = CGPoint(x: Mark.dot.cx, y: Mark.dot.cy).applying(t)
        dot = Circle(cx: c.x, cy: c.y, r: Mark.dot.r * scale)
        bounds = rawBounds.applying(t)
        tailTip = Mark.tail[2].applying(t)
    }
}
let icon = Layout(scale: Mark.iconScale)
let maskable = Layout(scale: Mark.maskableScale)

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
    var cg: CGColor { cg(1) }
    func cg(_ alpha: CGFloat) -> CGColor { CGColor(srgbRed: r, green: g, blue: b, alpha: alpha) }
    /// Icon Composer's colour syntax.
    var icon: String { String(format: "srgb:%.5f,%.5f,%.5f,1.00000", Double(r), Double(g), Double(b)) }
}

let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()   // brand/scripts
let brandDir = here.deletingLastPathComponent()                          // brand
let repo = brandDir.deletingLastPathComponent()
let tokens = try! JSONSerialization.jsonObject(with: Data(contentsOf: repo.appendingPathComponent("packages/tokens/tokens.json"))) as! [String: Any]
let mark = (tokens["brand"] as! [String: Any])["mark"] as! [String: String]
func color(_ key: String) -> RGB {
    guard let hex = mark[key] else { fatalError("tokens.json brand.mark.\(key) is missing") }
    return RGB(hex)
}
let blue = color("gradientStart"), violet = color("gradientEnd")
let lift = color("lift"), space = color("space")
let shadowColor = color("shadow"), glyphColor = color("glyph"), glyphShade = color("glyphShade")
let dotColor = color("dot"), dotOnLight = color("dotOnLight")
let white = RGB("#FFFFFF")

let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

// MARK: - The look, one recipe for every renderer

// A white mark on a rich purple tile: the contrast carries it at every size.
// The tile is the official gradient on the diagonal, lifted with a lighter
// violet behind the mark and weighted at the foot; the mark is one white
// material (glyph and dot alike), raised on a soft shadow.
struct Glow { let x, y, r: CGFloat; let color: RGB; let alpha: CGFloat }
struct Tile { let from: RGB; let to: RGB; let glows: [Glow]; let foot: CGFloat }
func tileLook(dark: Bool) -> Tile {
    dark
        ? Tile(from: space, to: space, glows: [
            Glow(x: 0.10, y: 0.05, r: 0.85, color: blue, alpha: 0.6),
            Glow(x: 0.95, y: 0.95, r: 0.80, color: violet, alpha: 0.65),
        ], foot: 0)
        : Tile(from: blue, to: violet, glows: [Glow(x: 0.5, y: 0.44, r: 0.62, color: lift, alpha: 0.5)], foot: 0.3)
}
/// The light, from the top-left.
let highlight = Glow(x: 0.2, y: 0.02, r: 0.8, color: white, alpha: 0.24)
/// The mark's soft shadow: offset down, blurred, and only outside the mark.
let shadowOffset: CGFloat = 18, shadowBlur: CGFloat = 44, shadowAlpha: CGFloat = 0.5

enum Background { case tile, tileDark, none }
enum MarkFill { case white, flat(CGColor) }
struct Look {
    var background: Background = .tile
    var fill: MarkFill = .white
    var shadow = true
    var highlight = true
    /// false draws the background alone.
    var mark = true
}
let iconLook = Look()
/// For 64 px and below: no shadow, so the edges stay crisp.
let smallLook = Look(shadow: false)

// MARK: - CoreGraphics

func flip(_ ctx: CGContext, height: CGFloat) {
    ctx.translateBy(x: 0, y: height)
    ctx.scaleBy(x: 1, y: -1)
}

func gradient(_ stops: [(CGColor, CGFloat)]) -> CGGradient {
    CGGradient(colorsSpace: srgb, colors: stops.map { $0.0 } as CFArray, locations: stops.map { $0.1 })!
}

func fill(_ ctx: CGContext, _ glow: Glow) {
    let c = CGPoint(x: glow.x * tile, y: glow.y * tile)
    ctx.drawRadialGradient(gradient([(glow.color.cg(glow.alpha), 0), (glow.color.cg(0), 1)]),
                           startCenter: c, startRadius: 0, endCenter: c, endRadius: glow.r * tile, options: [])
}

func drawBackground(_ ctx: CGContext, dark: Bool) {
    let t = tileLook(dark: dark)
    let all: CGGradientDrawingOptions = [.drawsBeforeStartLocation, .drawsAfterEndLocation]
    ctx.drawLinearGradient(gradient([(t.from.cg, 0), (t.to.cg, 1)]), start: .zero, end: CGPoint(x: tile, y: tile), options: all)
    t.glows.forEach { fill(ctx, $0) }
    if t.foot > 0 {
        ctx.drawLinearGradient(gradient([(shadowColor.cg(0), 0.5), (shadowColor.cg(t.foot), 1)]),
                               start: .zero, end: CGPoint(x: 0, y: tile), options: all)
    }
}

/// `unit` is base-space units per tile unit: shadows are specified in base
/// space, which the tile's scale doesn't reach.
func draw(_ ctx: CGContext, _ look: Look, _ l: Layout, unit: CGFloat) {
    switch look.background {
    case .tile: drawBackground(ctx, dark: false)
    case .tileDark: drawBackground(ctx, dark: true)
    case .none: break
    }
    guard look.mark else { return }
    let mark = CGMutablePath()
    mark.addPath(l.glyph)
    mark.addEllipse(in: l.dot.rect)

    if look.shadow {
        // In a layer: the mark casts its shadow, then the mark itself is
        // cleared, so the shadow never shows through it.
        ctx.saveGState()
        ctx.beginTransparencyLayer(auxiliaryInfo: nil)
        ctx.setShadow(offset: CGSize(width: 0, height: -shadowOffset * unit), blur: shadowBlur * unit,
                      color: shadowColor.cg(shadowAlpha))
        ctx.setFillColor(shadowColor.cg)
        ctx.addPath(mark)
        ctx.fillPath()
        ctx.setShadow(offset: .zero, blur: 0, color: nil)
        ctx.setBlendMode(.clear)
        ctx.addPath(mark)
        ctx.fillPath()
        ctx.endTransparencyLayer()
        ctx.restoreGState()
    }

    ctx.saveGState()
    ctx.addPath(mark)
    ctx.clip()
    switch look.fill {
    case .white:
        // White at the top, the faintest violet at the foot: form, not colour.
        ctx.drawLinearGradient(gradient([(white.cg, 0), (glyphShade.cg, 1)]), start: CGPoint(x: 0, y: l.bounds.minY),
                               end: CGPoint(x: 0, y: l.bounds.maxY), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    case .flat(let c):
        ctx.setFillColor(c)
        ctx.fill(l.bounds)
    }
    ctx.restoreGState()

    if look.highlight { fill(ctx, highlight) }
}

func render(size: Int, opaque: Bool, rounded: Bool = false, _ look: Look, _ l: Layout) -> CGImage {
    // Opaque (no alpha channel) where App Store validation demands it.
    let info: CGImageAlphaInfo = opaque ? .noneSkipLast : .premultipliedLast
    let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                        space: srgb, bitmapInfo: info.rawValue)!
    ctx.interpolationQuality = .high
    flip(ctx, height: CGFloat(size))
    let unit = CGFloat(size) / tile
    ctx.scaleBy(x: unit, y: unit)
    if rounded {
        ctx.addPath(CGPath(roundedRect: CGRect(x: 0, y: 0, width: tile, height: tile),
                           cornerWidth: Mark.cornerRadius, cornerHeight: Mark.cornerRadius, transform: nil))
        ctx.clip()
    }
    draw(ctx, look, l, unit: unit)
    return ctx.makeImage()!
}

func pngData(_ image: CGImage) -> Data {
    let data = NSMutableData()
    let dest = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { fatalError("PNG encoding failed") }
    return data as Data
}

func write(_ data: Data, _ path: String) {
    let url = repo.appendingPathComponent(path).standardizedFileURL
    try! FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try! data.write(to: url)
    print("wrote \(url.path.replacingOccurrences(of: repo.path + "/", with: ""))")
}
func write(_ text: String, _ path: String) { write(Data(text.utf8), path) }
func write(_ image: CGImage, _ path: String) { write(pngData(image), path) }

/// An .ico holding PNGs (every browser since IE Vista reads these).
func ico(_ sizes: [Int], _ look: Look) -> Data {
    let pngs = sizes.map { pngData(render(size: $0, opaque: false, rounded: true, look, icon)) }
    var out = Data()
    func u16(_ v: Int) { out.append(contentsOf: [UInt8(v & 0xFF), UInt8(v >> 8 & 0xFF)]) }
    func u32(_ v: Int) { u16(v & 0xFFFF); u16(v >> 16) }
    u16(0); u16(1); u16(sizes.count)
    var offset = 6 + 16 * sizes.count
    for (size, png) in zip(sizes, pngs) {
        out.append(contentsOf: [UInt8(size >= 256 ? 0 : size), UInt8(size >= 256 ? 0 : size), 0, 0])
        u16(1); u16(32); u32(png.count); u32(offset)
        offset += png.count
    }
    pngs.forEach { out.append($0) }
    return out
}

// MARK: - iOS: the Liquid Glass icon (Icon Composer)

// The system renders the glass, the moving specular light and the shadows from
// these layers; the art is flat. Two groups over a background layer, so the dot
// floats on its own plane above the "a".
let iconDir = "apps/ios/AlgoMinutes/Resources/AppIcon.icon"
write(render(size: 1024, opaque: true, Look(background: .tile, highlight: false, mark: false), icon), "\(iconDir)/Assets/background.png")
write(render(size: 1024, opaque: true, Look(background: .tileDark, highlight: false, mark: false), icon), "\(iconDir)/Assets/background-dark.png")

func n(_ v: CGFloat) -> String {
    let s = String(format: "%.1f", Double(v))
    return s.hasSuffix(".0") ? String(s.dropLast(2)) : s
}
func svgPath(_ p: CGPath) -> String {
    var d = ""
    p.applyWithBlock { e in
        let pts = e.pointee.points
        switch e.pointee.type {
        case .moveToPoint: d += "M\(n(pts[0].x)) \(n(pts[0].y))"
        case .addLineToPoint: d += "L\(n(pts[0].x)) \(n(pts[0].y))"
        case .addQuadCurveToPoint: d += "Q\(n(pts[0].x)) \(n(pts[0].y)) \(n(pts[1].x)) \(n(pts[1].y))"
        case .addCurveToPoint: d += "C\(n(pts[0].x)) \(n(pts[0].y)) \(n(pts[1].x)) \(n(pts[1].y)) \(n(pts[2].x)) \(n(pts[2].y))"
        case .closeSubpath: d += "Z"
        @unknown default: fatalError("unknown path element")
        }
    }
    return d
}
let generated = "<!-- Generated by brand/scripts/generate.swift from packages/tokens/tokens.json (brand.mark). Don't edit by hand. -->"
func layerSVG(_ body: String) -> String {
    """
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
      \(generated)
      \(body)
    </svg>

    """
}
write(layerSVG("<path d=\"\(svgPath(icon.glyph))\" fill=\"\(glyphColor.hex)\"/>"), "\(iconDir)/Assets/glyph.svg")
write(layerSVG("<circle cx=\"\(n(icon.dot.cx))\" cy=\"\(n(icon.dot.cy))\" r=\"\(n(icon.dot.r))\" fill=\"\(glyphColor.hex)\"/>"),
      "\(iconDir)/Assets/dot.svg")

/// In dark mode iOS recolours glass layers from the fill; these pin the mark
/// white. Translucency is off, so the glass stays a solid white.
func solid(_ c: RGB) -> [String: Any] { ["solid": c.icon] }
func darkOnly(_ value: Any) -> [[String: Any]] { [["appearance": "dark", "value": value]] }
let iconJSON: [String: Any] = [
    "fill-specializations": [
        ["value": ["linear-gradient": [blue.icon, violet.icon],
                   "orientation": ["start": ["x": 0, "y": 0], "stop": ["x": 1, "y": 1]]]],
        ["appearance": "dark", "value": solid(space)],
    ],
    "groups": [
        [
            "name": "Dot",
            "layers": [["name": "dot", "image-name": "dot.svg", "glass": true, "fill-specializations": darkOnly(solid(glyphColor))]],
            "shadow": ["kind": "neutral", "opacity": 0.5],
            "translucency": ["enabled": false, "value": 0.2],
            "specular": true,
            "lighting": "combined",
        ],
        [
            "name": "Glyph",
            "layers": [["name": "glyph", "image-name": "glyph.svg", "glass": true, "fill-specializations": darkOnly(solid(glyphColor))]],
            "shadow": ["kind": "neutral", "opacity": 0.5],
            "translucency": ["enabled": false, "value": 0.4],
            "specular": true,
            "lighting": "combined",
        ],
        [
            "name": "Background",
            "layers": [[
                "name": "background",
                "image-name-specializations": [
                    ["value": "background.png"],
                    ["appearance": "dark", "value": "background-dark.png"],
                ],
                "glass": false,
            ]],
            "shadow": ["kind": "none", "opacity": 0.5],
            "translucency": ["enabled": false, "value": 0.5],
        ],
    ],
    "supported-platforms": ["squares": ["iOS"]],
]
write(try! JSONSerialization.data(withJSONObject: iconJSON, options: [.prettyPrinted, .sortedKeys]), "\(iconDir)/icon.json")

// MARK: - iOS before Xcode 26: the flattened icon

// Xcode 26 builds AppIcon.icon and passes this set over; an older Xcode (a CI
// runner's default, say) knows only this one, and fails the build without it.
// The same recipe draws both, so they can't drift.
let appIconSet = "apps/ios/AlgoMinutes/Resources/Assets.xcassets/AppIcon.appiconset"
write(render(size: 1024, opaque: true, iconLook, icon), "\(appIconSet)/AppIcon-1024.png")
// Dark and tinted: the mark alone; iOS supplies the tile.
write(render(size: 1024, opaque: false, Look(background: .none, highlight: false), icon), "\(appIconSet)/AppIcon-1024-dark.png")
write(render(size: 1024, opaque: false, Look(background: .none, fill: .flat(CGColor(gray: 1, alpha: 1)), shadow: false, highlight: false), icon),
      "\(appIconSet)/AppIcon-1024-tinted.png")

// MARK: - iOS: the in-app logo

do {
    let url = repo.appendingPathComponent("apps/ios/AlgoMinutes/Resources/Assets.xcassets/Logo.imageset/logo.pdf")
    var box = CGRect(x: 0, y: 0, width: 96, height: 96)   // points
    let pdf = CGContext(url as CFURL, mediaBox: &box, nil)!
    pdf.beginPDFPage(nil)
    // Quartz drops the gradients' transparency when it writes a PDF, so the
    // tile goes in as a 512 px image: over 5x at 96 pt, enough for @3x.
    pdf.draw(render(size: 512, opaque: false, rounded: true, iconLook, icon), in: box)
    pdf.endPDFPage()
    pdf.closePDF()
    // Quartz stamps the time and a random file ID; pin both (same length, so
    // the offsets hold) so a re-run doesn't change the file. Latin-1 maps every
    // byte to one character and back, so the binary streams survive.
    var bytes = String(data: try! Data(contentsOf: url), encoding: .isoLatin1)!
    bytes = bytes.replacingOccurrences(of: #"D:\d{14}Z00'00'"#, with: "D:20260927000000Z00'00'", options: .regularExpression)
    bytes = bytes.replacingOccurrences(of: #"<[0-9a-f]{32}>"#, with: "<a1a0a1a0a1a0a1a0a1a0a1a0a1a0a1a0>", options: .regularExpression)
    try! bytes.data(using: .isoLatin1)!.write(to: url)
    print("wrote \(url.path.replacingOccurrences(of: repo.path + "/", with: ""))")
}

// MARK: - SVG (the same recipe, for the web and documents)

func stop(_ c: RGB, _ at: CGFloat, _ alpha: CGFloat = 1) -> String {
    "<stop offset=\"\(n(at * 100) + "%")\" stop-color=\"\(c.hex)\"" + (alpha < 1 ? " stop-opacity=\"\(String(format: "%.2f", Double(alpha)))\"" : "") + "/>"
}
func radialDef(_ id: String, _ b: Glow) -> String {
    "<radialGradient id=\"\(id)\" cx=\"\(n(b.x * tile))\" cy=\"\(n(b.y * tile))\" r=\"\(n(b.r * tile))\" gradientUnits=\"userSpaceOnUse\">"
        + stop(b.color, 0, b.alpha) + stop(b.color, 1, 0) + "</radialGradient>"
}
func linearDef(_ id: String, box: CGRect, dx: CGFloat, _ stops: [String]) -> String {
    "<linearGradient id=\"\(id)\" x1=\"\(n(box.minX))\" y1=\"\(n(box.minY))\" x2=\"\(n(box.minX + dx * box.width))\" y2=\"\(n(box.maxY))\" gradientUnits=\"userSpaceOnUse\">"
        + stops.joined() + "</linearGradient>"
}
struct SVGParts { var defs: [String]; var body: [String] }
func svgDoc(_ title: String, _ parts: SVGParts, width: CGFloat = tile, height: CGFloat = tile) -> String {
    """
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 \(n(width)) \(n(height))" width="\(n(width))" height="\(n(height))">
      <title>\(title)</title>
      \(generated)
      <defs>
        \(parts.defs.joined(separator: "\n    "))
      </defs>
      \(parts.body.joined(separator: "\n  "))
    </svg>

    """
}

/// The tile: the purple gradient and the white mark. `p` prefixes every id,
/// so a tile can sit inside another drawing.
func tileParts(_ l: Layout, rounded: Bool, shadow: Bool = true, id p: String = "") -> SVGParts {
    let t = tileLook(dark: false)
    let glyphD = svgPath(l.glyph)
    let dot = "<circle cx=\"\(n(l.dot.cx))\" cy=\"\(n(l.dot.cy))\" r=\"\(n(l.dot.r))\""
    var defs = ["<linearGradient id=\"\(p)bg\" x1=\"0\" y1=\"0\" x2=\"1024\" y2=\"1024\" gradientUnits=\"userSpaceOnUse\">" + stop(t.from, 0) + stop(t.to, 1) + "</linearGradient>"]
    defs += t.glows.enumerated().map { radialDef("\(p)glow\($0.offset)", $0.element) }
    defs.append("<linearGradient id=\"\(p)foot\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1024\" gradientUnits=\"userSpaceOnUse\">" + stop(shadowColor, 0.5, 0) + stop(shadowColor, 1, t.foot) + "</linearGradient>")
    defs.append(radialDef("\(p)light", highlight))
    defs.append("<linearGradient id=\"\(p)mark\" x1=\"0\" y1=\"\(n(l.bounds.minY))\" x2=\"0\" y2=\"\(n(l.bounds.maxY))\" gradientUnits=\"userSpaceOnUse\">" + stop(white, 0) + stop(glyphShade, 1) + "</linearGradient>")
    if shadow {
        defs.append("<filter id=\"\(p)soft\" x=\"-20%\" y=\"-20%\" width=\"140%\" height=\"160%\"><feGaussianBlur stdDeviation=\"\(n(shadowBlur / 2))\"/></filter>")
        defs.append("<mask id=\"\(p)outside\" maskUnits=\"userSpaceOnUse\" x=\"0\" y=\"0\" width=\"1024\" height=\"1024\"><rect width=\"1024\" height=\"1024\" fill=\"#fff\"/><path d=\"\(glyphD)\"/>\(dot)/></mask>")
    }
    if rounded {
        defs.append("<clipPath id=\"\(p)tile\"><rect width=\"1024\" height=\"1024\" rx=\"\(n(Mark.cornerRadius))\"/></clipPath>")
    }
    var body = ["<rect width=\"1024\" height=\"1024\" fill=\"url(#\(p)bg)\"/>"]
    body += t.glows.indices.map { "<rect width=\"1024\" height=\"1024\" fill=\"url(#\(p)glow\($0))\"/>" }
    body.append("<rect width=\"1024\" height=\"1024\" fill=\"url(#\(p)foot)\"/>")
    if shadow {
        body.append("<g mask=\"url(#\(p)outside)\"><g filter=\"url(#\(p)soft)\" transform=\"translate(0 \(n(shadowOffset)))\" fill=\"\(shadowColor.hex)\" fill-opacity=\"\(n(shadowAlpha))\"><path d=\"\(glyphD)\"/>\(dot)/></g></g>")
    }
    body.append("<path d=\"\(glyphD)\" fill=\"url(#\(p)mark)\"/>")
    body.append("\(dot) fill=\"url(#\(p)mark)\"/>")
    body.append("<rect width=\"1024\" height=\"1024\" fill=\"url(#\(p)light)\"/>")
    if rounded { body = ["<g clip-path=\"url(#\(p)tile)\">"] + body.map { "  " + $0 } + ["</g>"] }
    return SVGParts(defs: defs, body: body)
}
func tileSVG(_ l: Layout, rounded: Bool, shadow: Bool = true) -> String {
    svgDoc("AlgoMinutes", tileParts(l, rounded: rounded, shadow: shadow))
}

write(tileSVG(icon, rounded: false), "brand/icon/icon.svg")
write(tileSVG(icon, rounded: true), "brand/icon/icon-rounded.svg")

// MARK: - The logo: the flat mark, the Geist wordmark and the lockups

/// A colourway: how the mark and the wordmark are filled on a given ground.
struct Colourway {
    let name: String
    let glyph: String, dot: String, algo: String, minutes: String, byline: String
    var defs: [String] = []
}
let brandFill = "url(#brand)"
let lavender = color("lavender"), ink = color("ink"), bylineColor = color("byline")
let colourways = [
    Colourway(name: "on-dark", glyph: glyphColor.hex, dot: glyphColor.hex, algo: glyphColor.hex, minutes: lavender.hex,
              byline: lavender.hex + "\" fill-opacity=\"0.72"),
    Colourway(name: "on-light", glyph: brandFill, dot: dotOnLight.hex, algo: ink.hex, minutes: brandFill, byline: bylineColor.hex),
    Colourway(name: "mono-white", glyph: "#FFFFFF", dot: "#FFFFFF", algo: "#FFFFFF", minutes: "#FFFFFF", byline: "#FFFFFF"),
    Colourway(name: "mono-black", glyph: "#000000", dot: "#000000", algo: "#000000", minutes: "#000000", byline: "#000000"),
]

func loadFont(_ name: String, _ size: CGFloat) -> CTFont {
    let url = brandDir.appendingPathComponent("fonts/\(name).otf")
    guard let d = (CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor])?.first else {
        fatalError("missing font \(url.path)")
    }
    return CTFontCreateWithFontDescriptor(d, size, nil)
}

/// Text as outlines, y down, baseline at y = 0: one path per segment, so each
/// segment can take its own colour.
func outline(_ segments: [(String, CTFont)], tracking: CGFloat) -> [CGPath] {
    let text = NSMutableAttributedString()
    let segmentKey = NSAttributedString.Key("AlgoMinutesSegment")
    for (i, (string, font)) in segments.enumerated() {
        text.append(NSAttributedString(string: string, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTKernAttributeName as String): tracking * CTFontGetSize(font),
            segmentKey: i,
        ]))
    }
    let paths = segments.map { _ in CGMutablePath() }
    for run in CTLineGetGlyphRuns(CTLineCreateWithAttributedString(text)) as! [CTRun] {
        let attrs = CTRunGetAttributes(run) as! [String: Any]
        let font = attrs[kCTFontAttributeName as String] as! CTFont
        let segment = attrs[segmentKey.rawValue] as! Int
        let count = CTRunGetGlyphCount(run)
        var glyphs = [CGGlyph](repeating: 0, count: count)
        var positions = [CGPoint](repeating: .zero, count: count)
        CTRunGetGlyphs(run, CFRange(location: 0, length: count), &glyphs)
        CTRunGetPositions(run, CFRange(location: 0, length: count), &positions)
        for (glyph, at) in zip(glyphs, positions) {
            var flip = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: at.x, ty: -at.y)
            if let path = CTFontCreatePathForGlyph(font, glyph, &flip) { paths[segment].addPath(path) }
        }
    }
    return paths
}
func ink(_ paths: [CGPath]) -> CGRect { paths.map(\.boundingBoxOfPath).reduce(CGRect.null) { $0.union($1) } }

// The wordmark: "Algo" in Geist Medium, "Minutes" in Geist Bold, as in the
// owner's artwork, tracked in a touch for display sizes.
let wordSize: CGFloat = 200
let medium = loadFont("Geist-Medium", wordSize), bold = loadFont("Geist-Bold", wordSize)
let capHeight = CTFontGetCapHeight(bold)
let word = outline([("Algo", medium), ("Minutes", bold)], tracking: -0.02)
let wordInk = ink(word)
let bylineFont = loadFont("Geist-SemiBold", wordSize * 0.2)
let byline = outline([("BY ALGORYTHMOS", bylineFont)], tracking: 0.34)
let bylineInk = ink(byline)

/// Places the flat mark so its bounding box (glyph and dot) spans `rect`'s height.
func markGroup(_ c: Colourway, height: CGFloat, x: CGFloat, top: CGFloat) -> (svg: String, width: CGFloat) {
    let s = height / icon.bounds.height
    let t = "translate(\(n(x)) \(n(top))) scale(\(String(format: "%.5f", Double(s)))) translate(\(n(-icon.bounds.minX)) \(n(-icon.bounds.minY)))"
    return ("<g transform=\"\(t)\"><path d=\"\(svgPath(icon.glyph))\" fill=\"\(c.glyph)\"/><circle cx=\"\(n(icon.dot.cx))\" cy=\"\(n(icon.dot.cy))\" r=\"\(n(icon.dot.r))\" fill=\"\(c.dot)\"/></g>",
            icon.bounds.width * s)
}
func pathsGroup(_ paths: [CGPath], fills: [String], dx: CGFloat, dy: CGFloat) -> String {
    "<g transform=\"translate(\(n(dx)) \(n(dy)))\">" + zip(paths, fills).map { "<path d=\"\(svgPath($0))\" fill=\"\($1)\"/>" }.joined() + "</g>"
}
/// The brand gradient, across the drawing's width (userSpaceOnUse, so every
/// shape that uses it shares one sweep).
func brandDef(width: CGFloat, height: CGFloat) -> String {
    linearDef("brand", box: CGRect(x: 0, y: 0, width: width, height: height), dx: 1, [stop(blue, 0), stop(violet, 1)])
}

enum Arrangement { case mark, wordmark, horizontal, endorsed, stacked, tile }
func logo(_ arrangement: Arrangement, _ c: Colourway) -> (svg: String, name: String) {
    // Trimmed to the artwork (2 units, so edges never clip); the clear space is
    // the user's to add (brand/README.md).
    let pad: CGFloat = 2
    var body: [String] = []
    var width: CGFloat = 0, height: CGFloat = 0
    let wordFills = [c.algo, c.minutes]
    switch arrangement {
    case .mark:
        // At the icon's size.
        let m = markGroup(c, height: icon.bounds.height, x: pad, top: pad)
        body = [m.svg]
        width = m.width + 2 * pad; height = icon.bounds.height + 2 * pad
    case .wordmark:
        body = [pathsGroup(word, fills: wordFills, dx: pad - wordInk.minX, dy: pad - wordInk.minY)]
        width = wordInk.width + 2 * pad; height = wordInk.height + 2 * pad
    case .horizontal, .endorsed, .tile:
        // The mark spans twice the cap height, centred on the capitals; with
        // the byline, it runs from the cap line to the byline's baseline.
        let bylineTop = capHeight * 0.62 + wordInk.maxY - capHeight * 0.42   // below the descenders
        let textTop = -capHeight, textBottom = arrangement == .endorsed ? bylineTop - bylineInk.minY + bylineInk.maxY : 0
        let markHeight = arrangement == .endorsed ? (textBottom - textTop) * 1.18 : capHeight * 2
        let markTop = (textTop + textBottom) / 2 - markHeight / 2
        let left = pad
        var textX: CGFloat
        if arrangement == .tile {
            let size = markHeight * 1.28, top = (textTop + textBottom) / 2 - size / 2
            var t = tileParts(icon, rounded: true, id: "t-")
            t.body = t.body.map { "  " + $0 }
            body.append("<svg x=\"\(n(left))\" y=\"\(n(top))\" width=\"\(n(size))\" height=\"\(n(size))\" viewBox=\"0 0 1024 1024\"><defs>\(t.defs.joined())</defs>\(t.body.joined())</svg>")
            textX = left + size + markHeight * 0.32
        } else {
            let m = markGroup(c, height: markHeight, x: left, top: markTop)
            body.append(m.svg)
            textX = left + m.width + markHeight * 0.38
        }
        body.append(pathsGroup(word, fills: wordFills, dx: textX - wordInk.minX, dy: 0))
        if arrangement == .endorsed {
            body.append(pathsGroup(byline, fills: [c.byline], dx: textX - bylineInk.minX + wordSize * 0.012, dy: bylineTop - bylineInk.minY))
        }
        let top = min(markTop, wordInk.minY) - pad
        let bottom = max(markTop + markHeight, textBottom, wordInk.maxY) + pad
        width = textX + wordInk.width + pad; height = bottom - top
        body = ["<g transform=\"translate(0 \(n(-top)))\">"] + body.map { "  " + $0 } + ["</g>"]
    case .stacked:
        let markHeight = capHeight * 3.4
        width = max(wordInk.width, 0) + 2 * pad
        let m = markGroup(c, height: markHeight, x: 0, top: pad)
        body.append("<g transform=\"translate(\(n((width - m.width) / 2)) 0)\">" + m.svg + "</g>")
        let baseline = pad + markHeight + capHeight * 0.55 + capHeight
        body.append(pathsGroup(word, fills: wordFills, dx: pad - wordInk.minX, dy: baseline))
        height = baseline + wordInk.maxY + pad
    }
    var defs = c.defs
    if [c.glyph, c.minutes].contains(brandFill) { defs.append(brandDef(width: width, height: height)) }
    let name: String
    switch arrangement {
    case .mark: name = "mark"
    case .wordmark: name = "wordmark"
    case .horizontal: name = "lockup"
    case .endorsed: name = "lockup-endorsed"
    case .stacked: name = "lockup-stacked"
    case .tile: name = "lockup-tile"
    }
    return (svgDoc("AlgoMinutes", SVGParts(defs: defs, body: body), width: width, height: height), "\(name)-\(c.name)")
}

for c in colourways {
    for a in [Arrangement.mark, .wordmark, .horizontal] { let l = logo(a, c); write(l.svg, "brand/logo/\(l.name).svg") }
}
for c in colourways.prefix(2) {
    for a in [Arrangement.endorsed, .stacked, .tile] { let l = logo(a, c); write(l.svg, "brand/logo/\(l.name).svg") }
}

// MARK: - The laid-out geometry, for the tests

func r1(_ v: CGFloat) -> Decimal { Decimal(string: String(format: "%.1f", Double(v)))! }
let markJSON: [String: Any] = [
    "$comment": "Generated by brand/scripts/generate.swift: the app icon's mark as laid out in a 1024 tile (y down). tests/brand-assets.test.ts checks its size and position.",
    "tile": 1024,
    "scale": Decimal(string: String(format: "%.2f", Double(icon.scale)))!,
    "cornerRadius": r1(Mark.cornerRadius),
    "bounds": ["x": r1(icon.bounds.minX), "y": r1(icon.bounds.minY), "width": r1(icon.bounds.width), "height": r1(icon.bounds.height)],
    "dot": ["cx": r1(icon.dot.cx), "cy": r1(icon.dot.cy), "r": r1(icon.dot.r)],
    "tailTip": ["x": r1(icon.tailTip.x), "y": r1(icon.tailTip.y)],
]
write(try! JSONSerialization.data(withJSONObject: markJSON, options: [.prettyPrinted, .sortedKeys]), "brand/mark.json")

// MARK: - The site and the web app

// Tabs and page logos: no shadow, so the mark stays crisp at 16 px.
let logoSVG = tileSVG(icon, rounded: true, shadow: false)
write(logoSVG, "apps/site/public/favicon.svg")
write(logoSVG, "apps/web/public/logo.svg")
write(ico([16, 32, 48], smallLook), "apps/site/public/favicon.ico")
// iOS rounds a touch icon itself, so it's square and opaque.
write(render(size: 180, opaque: true, iconLook, icon), "apps/site/public/apple-touch-icon.png")
write(render(size: 180, opaque: true, iconLook, icon), "apps/web/public/apple-touch-icon.png")
write(render(size: 500, opaque: false, rounded: true, iconLook, icon), "apps/web/public/logo.png")
for size in [16, 32] {
    write(render(size: size, opaque: false, rounded: true, smallLook, icon), "apps/web/public/favicon-\(size).png")
}
for size in [48, 72, 96, 128, 192, 256, 512] {
    write(render(size: size, opaque: false, rounded: true, size <= 64 ? smallLook : iconLook, icon), "apps/web/public/icon-\(size).png")
}
// A maskable icon is full-bleed; Android crops it to any shape inside the
// central 80% circle, so the mark is smaller.
for size in [192, 512] {
    write(render(size: size, opaque: true, iconLook, maskable), "apps/web/public/icon-maskable-\(size).png")
}

// MARK: - The kit's icon files

write(render(size: 1024, opaque: true, iconLook, icon), "brand/icon/app-icon-1024.png")
write(render(size: 1024, opaque: false, rounded: true, iconLook, icon), "brand/icon/icon-rounded-1024.png")
// An avatar is cropped to a circle: the mark sits inside it.
write(render(size: 800, opaque: true, iconLook, Layout(scale: 1.4)), "brand/social/profile-800.png")

// iOS's own renditions of the Liquid Glass icon, for decks and store art.
let ictool = "/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool"
if FileManager.default.isExecutableFile(atPath: ictool) {
    let renditions = [("Default", "light"), ("Dark", "dark"), ("ClearLight", "clear-light"), ("ClearDark", "clear-dark"),
                      ("TintedLight", "tinted-light"), ("TintedDark", "tinted-dark")]
    for (rendition, name) in renditions {
        let out = "brand/icon/ios-\(name).png"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: ictool)
        p.arguments = [repo.appendingPathComponent(iconDir).path, "--export-image", "--output-file", repo.appendingPathComponent(out).path,
                       "--platform", "iOS", "--rendition", rendition, "--width", "1024", "--height", "1024", "--scale", "1"]
        p.standardOutput = FileHandle.nullDevice
        try! p.run()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { fatalError("ictool failed for \(rendition)") }
        // ictool writes 16 bits a channel; 8 is plenty and half the size.
        let url = repo.appendingPathComponent(out)
        let src = CGImageSourceCreateWithURL(url as CFURL, nil).flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) }!
        let ctx = CGContext(data: nil, width: src.width, height: src.height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: srgb, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(src, in: CGRect(x: 0, y: 0, width: src.width, height: src.height))
        write(ctx.makeImage()!, out)
    }
} else {
    print("skipped brand/icon/ios-*.png: Xcode 26's ictool isn't installed")
}

// MARK: - Motion: the animated mark (CSS only, so it runs in an <img>)

do {
    var t = tileParts(icon, rounded: true)
    let d = icon.dot
    // A band of light sweeps across the tile behind the mark; the dot breathes,
    // and a ring leaves it like a listening indicator. Nothing moves under
    // reduced motion.
    t.defs.append("<linearGradient id=\"sheen\" x1=\"0\" x2=\"1\"><stop offset=\"0\" stop-color=\"#FFFFFF\" stop-opacity=\"0\"/><stop offset=\"0.5\" stop-color=\"#FFFFFF\" stop-opacity=\"0.32\"/><stop offset=\"1\" stop-color=\"#FFFFFF\" stop-opacity=\"0\"/></linearGradient>")
    let style = """
    <style>
        .sheen { animation: sheen 3.6s cubic-bezier(.6,0,.2,1) infinite; }
        .dot, .ring { transform-box: fill-box; transform-origin: center; }
        .dot { animation: breathe 1.8s ease-in-out infinite; }
        .ring { animation: ring 1.8s ease-out infinite; }
        @keyframes sheen { 0% { transform: translateX(-700px); } 55%, 100% { transform: translateX(1100px); } }
        @keyframes breathe { 50% { transform: scale(1.08); } }
        @keyframes ring { 0% { transform: scale(1); opacity: .7; } 100% { transform: scale(2.1); opacity: 0; } }
        @media (prefers-reduced-motion: reduce) { .sheen, .dot, .ring { animation: none; } .sheen, .ring { opacity: 0; } }
      </style>
    """
    let dotIndex = t.body.firstIndex { $0.contains("<circle") && $0.contains("url(#mark)") }!
    t.body[dotIndex] = t.body[dotIndex].replacingOccurrences(of: "<circle", with: "<circle class=\"dot\"")
    t.body.insert("  <circle class=\"ring\" cx=\"\(n(d.cx))\" cy=\"\(n(d.cy))\" r=\"\(n(d.r))\" fill=\"none\" stroke=\"#FFFFFF\" stroke-width=\"10\"/>", at: dotIndex)
    // Behind the mark: the tile's layers come first, then its shadow and the mark.
    let behindMark = t.body.firstIndex { $0.contains("url(#foot)") }! + 1
    t.body.insert("    <g class=\"sheen\"><rect x=\"0\" y=\"-200\" width=\"300\" height=\"1500\" fill=\"url(#sheen)\" transform=\"rotate(18 150 550)\"/></g>", at: behindMark)
    let svg = svgDoc("AlgoMinutes", t).replacingOccurrences(of: "<defs>", with: style + "\n  <defs>")
    write(svg, "brand/motion/mark-animated.svg")
}
