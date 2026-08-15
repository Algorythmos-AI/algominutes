#!/usr/bin/env swift
// Deterministic AlgoMinutes app-icon generator — pure CoreGraphics, no SwiftUI /
// SF Symbols (their rendering drifts across OS releases). Draws the brand
// waveform: five white capsule bars on near-black, matching LoginView's mark
// and the monochrome greyscale tokens (#FFFFFF -> #DEDDDE, Theme.swift).
//
// Usage: swift scripts/generate-app-icon.swift <output-dir>
// Emits: AppIcon-1024.png (opaque — App Store rejects alpha in the primary),
//        AppIcon-1024-dark.png (transparent bg for iOS 18 dark home screens),
//        AppIcon-1024-tinted.png (white bars, transparent — iOS applies tint).

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let size = 1024
let accent = CGColor(red: 1, green: 1, blue: 1, alpha: 1)
let accentPressed = CGColor(red: 0xDE / 255.0, green: 0xDD / 255.0, blue: 0xDE / 255.0, alpha: 1)

let barWidth: CGFloat = 72
let barGap: CGFloat = 56
let barHeights: [CGFloat] = [0.30, 0.58, 0.86, 0.58, 0.30].map { $0 * 620 }

func makeContext(opaque: Bool = false) -> CGContext {
    // Opaque (no alpha channel) for the primary icon — App Store rejects
    // alpha there; transparent variants use premultiplied alpha.
    let alphaInfo: CGImageAlphaInfo = opaque ? .noneSkipLast : .premultipliedLast
    return CGContext(
        data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: alphaInfo.rawValue
    )!
}

func addCapsule(_ ctx: CGContext, x: CGFloat, height: CGFloat) {
    let rect = CGRect(x: x, y: (CGFloat(size) - height) / 2, width: barWidth, height: height)
    ctx.addPath(CGPath(roundedRect: rect, cornerWidth: barWidth / 2, cornerHeight: barWidth / 2, transform: nil))
}

func drawBars(_ ctx: CGContext, gradient: Bool, glow: Bool) {
    let totalWidth = 5 * barWidth + 4 * barGap
    var x = (CGFloat(size) - totalWidth) / 2
    for height in barHeights {
        ctx.saveGState()
        if glow {
            ctx.setShadow(
                offset: .zero, blur: 60,
                color: CGColor(gray: 1, alpha: 0.35)
            )
        }
        addCapsule(ctx, x: x, height: height)
        if gradient {
            ctx.clip()
            let g = CGGradient(
                colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                colors: [accent, accentPressed] as CFArray, locations: [0, 1]
            )!
            let rect = CGRect(x: x, y: (CGFloat(size) - height) / 2, width: barWidth, height: height)
            ctx.drawLinearGradient(
                g,
                start: CGPoint(x: rect.midX, y: rect.maxY),
                end: CGPoint(x: rect.midX, y: rect.minY),
                options: []
            )
        } else {
            ctx.setFillColor(CGColor(gray: 1, alpha: 1))
            ctx.fillPath()
        }
        ctx.restoreGState()
        x += barWidth + barGap
    }
}

func drawBackground(_ ctx: CGContext) {
    // Vertical #0D0D0F -> #000000, echoing OwllBackground's near-black.
    let g = CGGradient(
        colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
        colors: [
            CGColor(red: 0x0D / 255.0, green: 0x0D / 255.0, blue: 0x0F / 255.0, alpha: 1),
            CGColor(gray: 0, alpha: 1),
        ] as CFArray,
        locations: [0, 1]
    )!
    ctx.drawLinearGradient(
        g, start: CGPoint(x: CGFloat(size) / 2, y: CGFloat(size)),
        end: CGPoint(x: CGFloat(size) / 2, y: 0), options: []
    )
    // Subtle centered accent glow, 8% — enough to lift the mark off pure black.
    let glow = CGGradient(
        colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
        colors: [
            CGColor(red: 0x0A / 255.0, green: 0x84 / 255.0, blue: 0xFF / 255.0, alpha: 0.08),
            CGColor(red: 0x0A / 255.0, green: 0x84 / 255.0, blue: 0xFF / 255.0, alpha: 0),
        ] as CFArray,
        locations: [0, 1]
    )!
    ctx.drawRadialGradient(
        glow,
        startCenter: CGPoint(x: CGFloat(size) / 2, y: CGFloat(size) / 2), startRadius: 0,
        endCenter: CGPoint(x: CGFloat(size) / 2, y: CGFloat(size) / 2), endRadius: 600,
        options: []
    )
}

func write(_ ctx: CGContext, to url: URL) {
    let image = ctx.makeImage()!
    let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { fatalError("failed writing \(url.path)") }
    print("wrote \(url.lastPathComponent)")
}

let outDir = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ".")

// Primary: opaque background + gradient bars + glow.
let primary = makeContext(opaque: true)
drawBackground(primary)
drawBars(primary, gradient: true, glow: true)
write(primary, to: outDir.appendingPathComponent("AppIcon-1024.png"))

// Dark: transparent background (iOS composites onto its dark tile).
let dark = makeContext()
drawBars(dark, gradient: true, glow: true)
write(dark, to: outDir.appendingPathComponent("AppIcon-1024-dark.png"))

// Tinted: white bars on transparent (iOS applies the user's tint).
let tinted = makeContext()
drawBars(tinted, gradient: false, glow: false)
write(tinted, to: outDir.appendingPathComponent("AppIcon-1024-tinted.png"))
