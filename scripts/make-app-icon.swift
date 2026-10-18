import AppKit
import Foundation

let directory = URL(fileURLWithPath: CommandLine.arguments[1])
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let image = NSImage(size: NSSize(width: pixels, height: pixels))
        image.lockFocus()
        let context = NSGraphicsContext.current!.cgContext
        context.scaleBy(x: CGFloat(pixels) / 1024, y: CGFloat(pixels) / 1024)
        let background = NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: 1024, height: 1024), xRadius: 220, yRadius: 220)
        NSGradient(colors: [NSColor(srgbRed: 0.08, green: 0.12, blue: 0.32, alpha: 1),
                            NSColor(srgbRed: 0.25, green: 0.32, blue: 0.82, alpha: 1)])!.draw(in: background, angle: 45)
        context.translateBy(x: 512, y: 512)
        context.rotate(by: -.pi / 5)
        for x: CGFloat in [-170, 170] {
            let ring = NSBezierPath(roundedRect: NSRect(x: x - 205, y: -145, width: 410, height: 290), xRadius: 145, yRadius: 145)
            (x < 0 ? NSColor.white : NSColor(srgbRed: 0.53, green: 0.96, blue: 0.83, alpha: 1)).setStroke()
            ring.lineWidth = 66; ring.stroke()
        }
        image.unlockFocus()
        let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
        let file = directory.appendingPathComponent("icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png")
        try bitmap.representation(using: .png, properties: [:])!.write(to: file)
    }
}
