#!/usr/bin/env swift
// The AlgoMinutes brand renderer: the "ai" mark, drawn once from measured
// geometry, in every form the apps and the site use. Pure CoreGraphics, so the
// output doesn't drift across OS releases.
//
// Usage (from apps/ios): swift scripts/generate-app-icon.swift
// Writes:
//   AlgoMinutes/Resources/AppIcon.icon/         the app icon, an Icon Composer document:
//     icon.json, Assets/{aurora,aurora-dark}.png, Assets/{glyph,dot}.svg. iOS 26
//     renders it as Liquid Glass; Xcode flattens it for iOS 17-25 and the App Store.
//   AlgoMinutes/Resources/Assets.xcassets/Logo.imageset/logo.pdf   the in-app logo, a vector
//   brand/icon.svg, brand/icon-rounded.svg      the glass tile, square and rounded
//   brand/mark-on-dark.svg, brand/mark-on-light.svg   the mark alone, flat, for UI
//   brand/mark.json          the laid-out geometry (tests/brand-assets.test.ts checks the size)
//   ../site/public/          favicon.svg, favicon.ico, apple-touch-icon.png
//   ../web/public/           logo.svg, logo.png, favicon-16/32, icon-48…512, icon-maskable-192/512,
//                            apple-touch-icon.png
//
// Colours come from packages/tokens/tokens.json (brand.mark). The geometry was
// measured from the owner's artwork (brand/README.md), in a 1024 tile, y down,
// and is laid out below: scaled ×1.75 and centred, so the mark fills 85% of the
// tile (docs/DECISIONS.md, 2026-09-27).

import CoreGraphics
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

let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()   // apps/ios/scripts
let ios = here.deletingLastPathComponent()                               // apps/ios
let repo = ios.appendingPathComponent("../..").standardizedFileURL
let tokens = try! JSONSerialization.jsonObject(with: Data(contentsOf: repo.appendingPathComponent("packages/tokens/tokens.json"))) as! [String: Any]
let mark = (tokens["brand"] as! [String: Any])["mark"] as! [String: String]
func color(_ key: String) -> RGB {
    guard let hex = mark[key] else { fatalError("tokens.json brand.mark.\(key) is missing") }
    return RGB(hex)
}
let blue = color("gradientStart"), violet = color("gradientEnd")
let auroraBase = color("auroraBase"), magenta = color("auroraMagenta"), space = color("space")
let shadowColor = color("shadow"), glyphColor = color("glyph")
let dotColor = color("dot"), dotShade = color("dotShade"), dotOnLight = color("dotOnLight")
let white = RGB("#FFFFFF")
let sphereMid = RGB("#E4DCFF")

let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

// MARK: - The look, one recipe for every renderer

/// Aurora blobs, as (centre, radius) in fractions of the tile, colour, opacity.
/// Blue from the top-left and violet from the bottom-right carry the official
/// gradient; a magenta bloom on the right gives it depth.
struct Blob { let x, y, r: CGFloat; let color: RGB; let alpha: CGFloat }
func aurora(dark: Bool) -> (base: RGB, blobs: [Blob]) {
    (dark ? space : auroraBase, [
        Blob(x: 0.10, y: 0.05, r: 0.80, color: blue, alpha: dark ? 0.70 : 1),
        Blob(x: 0.95, y: 0.95, r: 0.75, color: violet, alpha: dark ? 0.75 : 1),
        Blob(x: 0.85, y: 0.35, r: 0.45, color: magenta, alpha: dark ? 0.45 : 0.8),
    ])
}
/// The specular light, from the top-left.
let highlight = Blob(x: 0.22, y: 0.04, r: 0.80, color: white, alpha: 0.35)
/// The glyph's soft shadow: offset down, blurred, and only outside the glyph.
let shadowOffset: CGFloat = 22, shadowBlur: CGFloat = 32, shadowAlpha: CGFloat = 0.55
/// Frosted glass: the fill fades down the glyph; the rim is bright at the top,
/// dim through the middle, and catches light again at the bottom.
let glassFill: [(alpha: CGFloat, at: CGFloat)] = [(0.94, 0), (0.66, 1)]
let glassRim: [(alpha: CGFloat, at: CGFloat)] = [(1, 0), (0.35, 0.5), (0.8, 1)]
let rimWidth: CGFloat = 8
/// The "i" dot, a sphere lit from the top-left, with a specular glint.
let sphere: [(color: RGB, at: CGFloat)] = [(white, 0), (sphereMid, 0.4), (dotShade, 1)]
let sphereFocus = CGPoint(x: 0.34, y: 0.28), sphereRadius: CGFloat = 0.85
func glint(_ d: Circle, scale: CGFloat) -> CGRect {
    CGRect(x: d.cx - 13.1 * scale - 16 * scale, y: d.cy - 14.9 * scale - 11 * scale, width: 32 * scale, height: 22 * scale)
}

enum Background { case aurora, auroraDark, none }
enum GlyphFill { case glass, solid, flat(CGColor) }
enum DotFill { case sphere, flat(CGColor) }
struct Look {
    var background: Background = .aurora
    var glyph: GlyphFill = .glass
    var dot: DotFill = .sphere
    var shadow = true
    var highlight = true
    /// false draws the background alone.
    var mark = true
}
let glassLook = Look()
/// For 64 px and below: a solid glyph reads; frosted glass turns to mush.
let solidLook = Look(glyph: .solid, shadow: false)

// MARK: - CoreGraphics

func flip(_ ctx: CGContext, height: CGFloat) {
    ctx.translateBy(x: 0, y: height)
    ctx.scaleBy(x: 1, y: -1)
}

func gradient(_ stops: [(CGColor, CGFloat)]) -> CGGradient {
    CGGradient(colorsSpace: srgb, colors: stops.map { $0.0 } as CFArray, locations: stops.map { $0.1 })!
}

func fill(_ ctx: CGContext, _ blob: Blob) {
    let c = CGPoint(x: blob.x * tile, y: blob.y * tile)
    ctx.drawRadialGradient(gradient([(blob.color.cg(blob.alpha), 0), (blob.color.cg(0), 1)]),
                           startCenter: c, startRadius: 0, endCenter: c, endRadius: blob.r * tile, options: [])
}

func drawBackground(_ ctx: CGContext, dark: Bool) {
    let a = aurora(dark: dark)
    ctx.setFillColor(a.base.cg)
    ctx.fill(CGRect(x: 0, y: 0, width: tile, height: tile))
    a.blobs.forEach { fill(ctx, $0) }
}

/// Draws a linear gradient inside `path`, from the top-left of `box` to a point
/// `dx` of the way across its bottom.
func fillLinear(_ ctx: CGContext, _ path: CGPath, box: CGRect, dx: CGFloat, _ stops: [(CGColor, CGFloat)]) {
    ctx.saveGState()
    ctx.addPath(path)
    ctx.clip()
    ctx.drawLinearGradient(gradient(stops), start: CGPoint(x: box.minX, y: box.minY),
                           end: CGPoint(x: box.minX + dx * box.width, y: box.maxY),
                           options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    ctx.restoreGState()
}

/// `unit` is base-space units per tile unit: shadows are specified in base
/// space, which the tile's scale doesn't reach.
func draw(_ ctx: CGContext, _ look: Look, _ l: Layout, unit: CGFloat) {
    switch look.background {
    case .aurora: drawBackground(ctx, dark: false)
    case .auroraDark: drawBackground(ctx, dark: true)
    case .none: break
    }
    guard look.mark else { return }
    let dotPath = CGPath(ellipseIn: l.dot.rect, transform: nil)
    let both = CGMutablePath()
    both.addPath(l.glyph)
    both.addPath(dotPath)

    if look.shadow {
        // In a layer: the glyph casts its shadow, then the glyph itself is
        // cleared, so no shadow sits under the glass.
        ctx.saveGState()
        ctx.beginTransparencyLayer(auxiliaryInfo: nil)
        ctx.setShadow(offset: CGSize(width: 0, height: -shadowOffset * unit), blur: shadowBlur * unit,
                      color: shadowColor.cg(shadowAlpha))
        ctx.setFillColor(shadowColor.cg)
        ctx.addPath(both)
        ctx.fillPath()
        ctx.setShadow(offset: .zero, blur: 0, color: nil)
        ctx.setBlendMode(.clear)
        ctx.addPath(both)
        ctx.fillPath()
        ctx.endTransparencyLayer()
        ctx.restoreGState()
    }

    let box = l.glyph.boundingBoxOfPath
    switch look.glyph {
    case .glass:
        fillLinear(ctx, l.glyph, box: box, dx: 0.3, glassFill.map { (white.cg($0.alpha), $0.at) })
        let rim = l.glyph.copy(strokingWithWidth: rimWidth, lineCap: .round, lineJoin: .round, miterLimit: 10)
        fillLinear(ctx, rim, box: box, dx: 0.4, glassRim.map { (white.cg($0.alpha), $0.at) })
    case .solid:
        fillLinear(ctx, l.glyph, box: box, dx: 0, [(white.cg, 0), (RGB("#F1EDFF").cg, 1)])
    case .flat(let c):
        ctx.setFillColor(c)
        ctx.addPath(l.glyph)
        ctx.fillPath()
    }

    switch look.dot {
    case .sphere:
        ctx.saveGState()
        ctx.addPath(dotPath)
        ctx.clip()
        let d = l.dot.rect
        let focus = CGPoint(x: d.minX + sphereFocus.x * d.width, y: d.minY + sphereFocus.y * d.height)
        ctx.drawRadialGradient(gradient(sphere.map { ($0.color.cg, $0.at) }), startCenter: focus, startRadius: 0,
                               endCenter: focus, endRadius: sphereRadius * d.width, options: [.drawsAfterEndLocation])
        ctx.restoreGState()
        ctx.setFillColor(white.cg(0.9))
        ctx.fillEllipse(in: glint(l.dot, scale: l.scale))
    case .flat(let c):
        ctx.setFillColor(c)
        ctx.addPath(dotPath)
        ctx.fillPath()
    }

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
    let url = ios.appendingPathComponent(path).standardizedFileURL
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
let iconDir = "AlgoMinutes/Resources/AppIcon.icon"
write(render(size: 1024, opaque: true, Look(background: .aurora, highlight: false, mark: false), icon), "\(iconDir)/Assets/aurora.png")
write(render(size: 1024, opaque: true, Look(background: .auroraDark, highlight: false, mark: false), icon), "\(iconDir)/Assets/aurora-dark.png")

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
let generated = "<!-- Generated by apps/ios/scripts/generate-app-icon.swift from packages/tokens/tokens.json (brand.mark). Don't edit by hand. -->"
func layerSVG(_ body: String) -> String {
    """
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
      \(generated)
      \(body)
    </svg>

    """
}
write(layerSVG("<path d=\"\(svgPath(icon.glyph))\" fill=\"\(glyphColor.hex)\"/>"), "\(iconDir)/Assets/glyph.svg")
write(layerSVG("<circle cx=\"\(n(icon.dot.cx))\" cy=\"\(n(icon.dot.cy))\" r=\"\(n(icon.dot.r))\" fill=\"\(dotColor.hex)\"/>"),
      "\(iconDir)/Assets/dot.svg")

/// In dark mode iOS recolours glass layers from the fill; these pin the glyph
/// white and the dot lavender on the deep-space aurora.
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
            "layers": [["name": "dot", "image-name": "dot.svg", "glass": true, "fill-specializations": darkOnly(solid(dotColor))]],
            "shadow": ["kind": "neutral", "opacity": 0.5],
            "translucency": ["enabled": true, "value": 0.2],
            "specular": true,
            "lighting": "combined",
        ],
        [
            "name": "Glyph",
            "layers": [["name": "glyph", "image-name": "glyph.svg", "glass": true, "fill-specializations": darkOnly(solid(glyphColor))]],
            "shadow": ["kind": "neutral", "opacity": 0.5],
            "translucency": ["enabled": true, "value": 0.4],
            "specular": true,
            "lighting": "combined",
        ],
        [
            "name": "Aurora",
            "layers": [[
                "name": "aurora",
                "image-name-specializations": [
                    ["value": "aurora.png"],
                    ["appearance": "dark", "value": "aurora-dark.png"],
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

// MARK: - iOS: the in-app logo

do {
    let url = ios.appendingPathComponent("AlgoMinutes/Resources/Assets.xcassets/Logo.imageset/logo.pdf")
    var box = CGRect(x: 0, y: 0, width: 96, height: 96)   // points; the asset scales as a vector
    let pdf = CGContext(url as CFURL, mediaBox: &box, nil)!
    pdf.beginPDFPage(nil)
    flip(pdf, height: box.height)
    pdf.scaleBy(x: box.width / tile, y: box.height / tile)
    pdf.addPath(CGPath(roundedRect: CGRect(x: 0, y: 0, width: tile, height: tile),
                       cornerWidth: Mark.cornerRadius, cornerHeight: Mark.cornerRadius, transform: nil))
    pdf.clip()
    draw(pdf, glassLook, icon, unit: box.width / tile)
    pdf.endPDFPage()
    pdf.closePDF()
    print("wrote \(url.path.replacingOccurrences(of: repo.path + "/", with: ""))")
}

// MARK: - SVG (the same recipe, for the web and documents)

func stop(_ c: RGB, _ at: CGFloat, _ alpha: CGFloat = 1) -> String {
    "<stop offset=\"\(n(at * 100) + "%")\" stop-color=\"\(c.hex)\"" + (alpha < 1 ? " stop-opacity=\"\(String(format: "%.2f", Double(alpha)))\"" : "") + "/>"
}
func radialDef(_ id: String, _ b: Blob) -> String {
    "<radialGradient id=\"\(id)\" cx=\"\(n(b.x * tile))\" cy=\"\(n(b.y * tile))\" r=\"\(n(b.r * tile))\" gradientUnits=\"userSpaceOnUse\">"
        + stop(b.color, 0, b.alpha) + stop(b.color, 1, 0) + "</radialGradient>"
}
func linearDef(_ id: String, box: CGRect, dx: CGFloat, _ stops: [String]) -> String {
    "<linearGradient id=\"\(id)\" x1=\"\(n(box.minX))\" y1=\"\(n(box.minY))\" x2=\"\(n(box.minX + dx * box.width))\" y2=\"\(n(box.maxY))\" gradientUnits=\"userSpaceOnUse\">"
        + stops.joined() + "</linearGradient>"
}
func svgDoc(_ title: String, defs: [String], body: [String]) -> String {
    """
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
      <title>\(title)</title>
      \(generated)
      <defs>
        \(defs.joined(separator: "\n    "))
      </defs>
      \(body.joined(separator: "\n  "))
    </svg>

    """
}

/// The tile as SVG: the aurora, the glyph (glass or solid) and the sphere.
func tileSVG(_ l: Layout, glass: Bool, rounded: Bool) -> String {
    let a = aurora(dark: false)
    let box = l.glyph.boundingBoxOfPath
    let d = l.dot.rect
    let g = glint(l.dot, scale: l.scale)
    let glyphD = svgPath(l.glyph)
    let dot = "<circle cx=\"\(n(l.dot.cx))\" cy=\"\(n(l.dot.cy))\" r=\"\(n(l.dot.r))\""
    var defs = a.blobs.enumerated().map { radialDef("aurora\($0.offset)", $0.element) }
    defs.append(radialDef("light", highlight))
    defs.append("<radialGradient id=\"sphere\" cx=\"\(n(d.minX + sphereFocus.x * d.width))\" cy=\"\(n(d.minY + sphereFocus.y * d.height))\" r=\"\(n(sphereRadius * d.width))\" gradientUnits=\"userSpaceOnUse\">"
                + sphere.map { stop($0.color, $0.at) }.joined() + "</radialGradient>")
    if glass {
        defs.append(linearDef("glass", box: box, dx: 0.3, glassFill.map { stop(white, $0.at, $0.alpha) }))
        defs.append(linearDef("rim", box: box, dx: 0.4, glassRim.map { stop(white, $0.at, $0.alpha) }))
        defs.append("<filter id=\"soft\" x=\"-20%\" y=\"-20%\" width=\"140%\" height=\"160%\"><feGaussianBlur stdDeviation=\"\(n(shadowBlur / 2))\"/></filter>")
        defs.append("<mask id=\"outside\" maskUnits=\"userSpaceOnUse\" x=\"0\" y=\"0\" width=\"1024\" height=\"1024\"><rect width=\"1024\" height=\"1024\" fill=\"#fff\"/><path d=\"\(glyphD)\"/>\(dot)/></mask>")
    } else {
        defs.append(linearDef("glass", box: box, dx: 0, [stop(white, 0), stop(RGB("#F1EDFF"), 1)]))
    }
    if rounded {
        defs.append("<clipPath id=\"tile\"><rect width=\"1024\" height=\"1024\" rx=\"\(n(Mark.cornerRadius))\"/></clipPath>")
    }
    var body = ["<rect width=\"1024\" height=\"1024\" fill=\"\(a.base.hex)\"/>"]
    body += a.blobs.indices.map { "<rect width=\"1024\" height=\"1024\" fill=\"url(#aurora\($0))\"/>" }
    if glass {
        body.append("<g mask=\"url(#outside)\"><g filter=\"url(#soft)\" transform=\"translate(0 \(n(shadowOffset)))\" fill=\"\(shadowColor.hex)\" fill-opacity=\"\(n(shadowAlpha))\"><path d=\"\(glyphD)\"/>\(dot)/></g></g>")
        body.append("<path d=\"\(glyphD)\" fill=\"url(#glass)\" stroke=\"url(#rim)\" stroke-width=\"\(n(rimWidth))\" stroke-linejoin=\"round\"/>")
    } else {
        body.append("<path d=\"\(glyphD)\" fill=\"url(#glass)\"/>")
    }
    body.append("\(dot) fill=\"url(#sphere)\"/>")
    body.append("<ellipse cx=\"\(n(g.midX))\" cy=\"\(n(g.midY))\" rx=\"\(n(g.width / 2))\" ry=\"\(n(g.height / 2))\" fill=\"#FFFFFF\" fill-opacity=\"0.9\"/>")
    body.append("<rect width=\"1024\" height=\"1024\" fill=\"url(#light)\"/>")
    if rounded { body = ["<g clip-path=\"url(#tile)\">"] + body.map { "  " + $0 } + ["</g>"] }
    return svgDoc("AlgoMinutes", defs: defs, body: body)
}

/// The mark alone, flat: for UI, on a known background.
func markSVG(_ title: String, glyphFill: String, dotFill: String, defs: [String] = []) -> String {
    svgDoc(title, defs: defs, body: [
        "<path d=\"\(svgPath(icon.glyph))\" fill=\"\(glyphFill)\"/>",
        "<circle cx=\"\(n(icon.dot.cx))\" cy=\"\(n(icon.dot.cy))\" r=\"\(n(icon.dot.r))\" fill=\"\(dotFill)\"/>",
    ])
}

write(tileSVG(icon, glass: true, rounded: false), "brand/icon.svg")
write(tileSVG(icon, glass: true, rounded: true), "brand/icon-rounded.svg")
write(markSVG("AlgoMinutes mark (on dark)", glyphFill: glyphColor.hex, dotFill: dotColor.hex), "brand/mark-on-dark.svg")
write(markSVG("AlgoMinutes mark (on light)", glyphFill: "url(#brand)", dotFill: dotOnLight.hex,
              defs: [linearDef("brand", box: icon.glyph.boundingBoxOfPath, dx: 1, [stop(blue, 0), stop(violet, 1)])]),
      "brand/mark-on-light.svg")

// MARK: - The laid-out geometry, for the tests

func r1(_ v: CGFloat) -> Decimal { Decimal(string: String(format: "%.1f", Double(v)))! }
let markJSON: [String: Any] = [
    "$comment": "Generated by apps/ios/scripts/generate-app-icon.swift: the app icon's mark as laid out in a 1024 tile (y down). tests/brand-assets.test.ts checks its size and position.",
    "tile": 1024,
    "scale": Decimal(string: String(format: "%.2f", Double(icon.scale)))!,
    "cornerRadius": r1(Mark.cornerRadius),
    "bounds": ["x": r1(icon.bounds.minX), "y": r1(icon.bounds.minY), "width": r1(icon.bounds.width), "height": r1(icon.bounds.height)],
    "dot": ["cx": r1(icon.dot.cx), "cy": r1(icon.dot.cy), "r": r1(icon.dot.r)],
    "tailTip": ["x": r1(icon.tailTip.x), "y": r1(icon.tailTip.y)],
]
write(try! JSONSerialization.data(withJSONObject: markJSON, options: [.prettyPrinted, .sortedKeys]), "brand/mark.json")

// MARK: - The site and the web app

// Tabs and page logos: the solid glyph, which stays crisp at 16 px.
let logoSVG = tileSVG(icon, glass: false, rounded: true)
write(logoSVG, "../site/public/favicon.svg")
write(logoSVG, "../web/public/logo.svg")
write(ico([16, 32, 48], solidLook), "../site/public/favicon.ico")
// iOS rounds a touch icon itself, so it's square and opaque.
write(render(size: 180, opaque: true, glassLook, icon), "../site/public/apple-touch-icon.png")
write(render(size: 180, opaque: true, glassLook, icon), "../web/public/apple-touch-icon.png")
write(render(size: 500, opaque: false, rounded: true, glassLook, icon), "../web/public/logo.png")
for size in [16, 32] {
    write(render(size: size, opaque: false, rounded: true, solidLook, icon), "../web/public/favicon-\(size).png")
}
for size in [48, 72, 96, 128, 192, 256, 512] {
    write(render(size: size, opaque: false, rounded: true, size <= 64 ? solidLook : glassLook, icon), "../web/public/icon-\(size).png")
}
// A maskable icon is full-bleed; Android crops it to any shape inside the
// central 80% circle, so the mark is smaller.
for size in [192, 512] {
    write(render(size: size, opaque: true, glassLook, maskable), "../web/public/icon-maskable-\(size).png")
}
