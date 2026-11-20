import Foundation
import CoreGraphics
import ImageIO
import PDFKit
import Vision
import AppKit

let maximumFileSize = 25 * 1024 * 1024
let maximumPages = 80
let maximumPixels = 40_000_000
let maximumText = 2_000_000

func writeFailure(_ message: String) -> Never {
    print(json(["ok": false, "error": message]))
    Foundation.exit(2)
}

func json(_ value: [String: Any]) -> String {
    guard JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value) else {
        return "{\"ok\":false,\"error\":\"JSON 输出无效\"}"
    }
    return String(data: data, encoding: .utf8) ?? "{\"ok\":false,\"error\":\"JSON 输出无效\"}"
}

func checkFile(_ path: String) {
    let attributes = (try? FileManager.default.attributesOfItem(atPath: path)) ?? [:]
    let size = attributes[.size] as? UInt64 ?? 0
    if size <= 0 || size > maximumFileSize {
        writeFailure("文件大小超出本地抽取上限（25 MB）。")
    }
}

func recognize(_ image: CGImage, orientation: CGImagePropertyOrientation) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    let handler = VNImageRequestHandler(cgImage: image, orientation: orientation, options: [:])
    try handler.perform([request])
    if let results = request.results, !results.isEmpty {
        return results.compactMap({ $0.topCandidates(1).first?.string }).joined(separator: "\n")
    }

    let retry = VNRecognizeTextRequest()
    retry.recognitionLevel = .accurate
    retry.usesLanguageCorrection = true
    let retryHandler = VNImageRequestHandler(cgImage: image, orientation: orientation, options: [:])
    try retryHandler.perform([retry])
    return retry.results?
        .compactMap({ $0.topCandidates(1).first?.string })
        .joined(separator: "\n") ?? ""
}

func renderPDF(_ page: PDFPage) -> CGImage? {
    let bounds = page.bounds(for: .mediaBox)
    let scale = min(2.0, 2200.0 / max(bounds.width, bounds.height))
    let width = max(1, Int(bounds.width * scale))
    let height = max(1, Int(bounds.height * scale))
    if height <= 0 || width > maximumPixels / height {
        writeFailure("这一页像素过大，已停止本地抽取。")
    }
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        return nil
    }
    context.setFillColor(NSColor.white.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.scaleBy(x: scale, y: scale)
    context.translateBy(x: -bounds.minX, y: -bounds.minY)
    page.draw(with: .mediaBox, to: context)
    return context.makeImage()
}

func extractPDF(_ path: String) {
    checkFile(path)
    guard let document = PDFDocument(url: URL(fileURLWithPath: path)) else {
        writeFailure("无法打开 PDF 原件。")
    }
    if document.pageCount == 0 || document.pageCount > maximumPages {
        writeFailure("PDF 页数超出本地抽取上限（80 页）。")
    }

    var texts: [String] = []
    var methods = Set<String>()
    var warnings: [String] = []
    for index in 0..<document.pageCount {
        guard let page = document.page(at: index) else {
            warnings.append("第 \(index + 1) 页无法读取。")
            continue
        }
        let printed = page.string?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !printed.isEmpty {
            texts.append(page.string ?? "")
            methods.insert("pdfkit")
            continue
        }
        guard let image = renderPDF(page) else {
            warnings.append("第 \(index + 1) 页无法渲染。")
            continue
        }
        do {
            let recognized = try recognize(image, orientation: .up)
            if !recognized.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                texts.append(recognized)
                methods.insert("vision")
            } else {
                warnings.append("第 \(index + 1) 页未识别到文字。")
            }
        } catch {
            warnings.append("第 \(index + 1) 页文字识别失败。")
        }
    }

    var text = texts.joined(separator: "\n\n")
    if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        writeFailure("PDF 中没有识别到可读文字。")
    }
    var truncated = false
    if text.count > maximumText {
        text = String(text.prefix(maximumText))
        truncated = true
    }
    if warnings.count > 8 {
        warnings = Array(warnings.prefix(8))
    }
    let method = methods.count > 1 ? "pdfkit+vision" : methods.first ?? "pdfkit"
    print(json([
        "ok": true,
        "text": text,
        "method": method,
        "pages": document.pageCount,
        "warnings": warnings,
        "truncated": truncated,
        "characterCount": text.count,
    ]))
}

func extractImage(_ path: String) {
    checkFile(path)
    let url = URL(fileURLWithPath: path)
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
        writeFailure("无法打开照片原件。")
    }
    guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any] else {
        writeFailure("照片属性无法读取。")
    }
    let width = properties[kCGImagePropertyPixelWidth as String] as? Int ?? 0
    let height = properties[kCGImagePropertyPixelHeight as String] as? Int ?? 0
    if width <= 0 || height <= 0 || height <= 0 || width > maximumPixels / height {
        writeFailure("照片像素过大，超出本地抽取上限。")
    }
    guard let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        writeFailure("照片内容无法读取。")
    }
    let orientationRaw = properties[kCGImagePropertyOrientation as String] as? UInt32 ?? 0
    let orientation = CGImagePropertyOrientation(rawValue: orientationRaw) ?? .up
    var warnings: [String] = []
    do {
        var text = try recognize(image, orientation: orientation)
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            writeFailure("照片中没有识别到可读文字。")
        }
        var truncated = false
        if text.count > maximumText {
            warnings.append("文字超过本地上限，已保存前 200 万字。")
            text = String(text.prefix(maximumText))
            truncated = true
        }
        print(json([
            "ok": true,
            "text": text,
            "method": "vision",
            "pages": 1,
            "warnings": warnings,
            "truncated": truncated,
            "characterCount": text.count,
        ]))
    } catch {
        writeFailure("照片文字识别失败。")
    }
}

guard CommandLine.arguments.dropFirst().count == 2 else {
    writeFailure("本地抽取脚本需要类型和文件路径。")
}
let kind = CommandLine.arguments[1]
let path = CommandLine.arguments[2]
if kind == "pdf" {
    extractPDF(path)
} else if kind == "image" {
    extractImage(path)
} else {
    writeFailure("不支持的本地抽取类型。")
}
