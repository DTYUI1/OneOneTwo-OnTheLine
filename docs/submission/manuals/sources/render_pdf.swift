import Foundation
import AppKit
import PDFKit

// Только чтение PDF и рендер страниц; не запускает браузер и приложение.
let args = CommandLine.arguments
if args.count < 3 { fatalError("usage: render_pdf.swift input.pdf output-directory") }
let input = URL(fileURLWithPath: args[1])
let out = URL(fileURLWithPath: args[2], isDirectory: true)
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
// Убираем только страницы предыдущего запуска, иначе уменьшение PDF оставит старые PNG.
for old in try FileManager.default.contentsOfDirectory(at: out, includingPropertiesForKeys: nil) {
    if old.lastPathComponent.range(of: "^[0-9]+\\.png$", options: .regularExpression) != nil {
        try FileManager.default.removeItem(at: old)
    }
}
guard let doc = PDFDocument(url: input) else { fatalError("cannot open PDF") }
var pages: [[String: Any]] = []
for i in 0..<doc.pageCount {
    guard let page = doc.page(at: i) else { continue }
    let bounds = page.bounds(for: .mediaBox)
    let size = NSSize(width: bounds.width * 1.25, height: bounds.height * 1.25)
    let image = page.thumbnail(of: size, for: .mediaBox)
    guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
          let png = bitmap.representation(using: .png, properties: [:]) else { fatalError("cannot render") }
    let name = String(format: "%02d.png", i + 1)
    try png.write(to: out.appendingPathComponent(name))
    let textBounds = page.selection(for: bounds)?.bounds(for: page) ?? CGRect.zero
    pages.append(["page": i + 1, "width": bounds.width, "height": bounds.height, "text_x": textBounds.origin.x, "text_y": textBounds.origin.y, "text_width": textBounds.width, "text_height": textBounds.height, "characters": (page.string ?? "").count])
}
let json = try JSONSerialization.data(withJSONObject: pages, options: [.prettyPrinted, .sortedKeys])
try json.write(to: out.appendingPathComponent("geometry.json"))
print("Rendered \(doc.pageCount) pages: \(out.path)")
