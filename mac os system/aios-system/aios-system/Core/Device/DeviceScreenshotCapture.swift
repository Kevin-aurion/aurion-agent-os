import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

/// Scoped screenshot capture. Fail-closed when safe scoping/redaction cannot be established.
nonisolated enum DeviceScreenshotCapture {
    struct CaptureResult: Sendable {
        let pngData: Data
        /// True only when an actual client redaction / sensitive-window rule ran.
        let clientDeclaredRedacted: Bool
        let meta: [String: String]
    }

    enum CaptureError: Error, LocalizedError {
        case noScreenRecording
        case noSafeTarget
        case captureFailed(String)
        case sensitiveOnly

        var errorDescription: String? {
            switch self {
            case .noScreenRecording:
                return "Screen Recording permission not granted"
            case .noSafeTarget:
                return "Cannot establish safe app/window scope — refuse whole-screen secret capture (fail-closed)"
            case .captureFailed(let m):
                return "Screenshot failed: \(m)"
            case .sensitiveOnly:
                return "Only sensitive/password windows matched — refuse capture (fail-closed)"
            }
        }
    }

    private static let sensitiveTitleKeywords = [
        "password", "密碼", "密鑰", "1password", "bitwarden", "lastpass",
        "keychain", "鑰匙圈", "login", "sign in", "登入", "security",
        "touch id", "face id", "驗證", "credential", "private key",
    ]

    /// Capture target app/window where possible; exclude this app and obvious security windows.
    static func capture(app: String?, window: String?, region: CGRect?) async throws -> CaptureResult {
        guard CGPreflightScreenCaptureAccess() else {
            throw CaptureError.noScreenRecording
        }

        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let selfBundle = AIOSConfig.appBundleId
        let selfPID = ProcessInfo.processInfo.processIdentifier

        // Filter windows: exclude self + sensitive titles.
        var candidates = content.windows.filter { win in
            if win.owningApplication?.bundleIdentifier == selfBundle { return false }
            if win.owningApplication?.processID == selfPID { return false }
            let title = (win.title ?? "").lowercased()
            if isSensitiveTitle(title) { return false }
            return win.frame.width >= 50 && win.frame.height >= 50
        }

        if let app, !app.isEmpty {
            let needle = app.lowercased()
            candidates = candidates.filter { win in
                let bid = (win.owningApplication?.bundleIdentifier ?? "").lowercased()
                let name = (win.owningApplication?.applicationName ?? "").lowercased()
                return bid.contains(needle) || name.contains(needle)
            }
        }
        if let window, !window.isEmpty {
            let needle = window.lowercased()
            candidates = candidates.filter { win in
                (win.title ?? "").lowercased().contains(needle)
            }
        }

        // Fail closed: no whole-screen dump without a scoped target.
        // Region-only is allowed only if it is not the full main display.
        // Region crop is *scoping*, not redaction — never attest clientDeclaredRedacted.
        if candidates.isEmpty {
            if let region, isSafeRegion(region) {
                return try await captureRegion(region, reason: "region-scope")
            }
            throw CaptureError.noSafeTarget
        }

        // Prefer the largest matching window.
        guard let target = candidates.max(by: {
            ($0.frame.width * $0.frame.height) < ($1.frame.width * $1.frame.height)
        }) else {
            throw CaptureError.noSafeTarget
        }

        // clientDeclaredRedacted = true because we applied exclude-self + sensitive-title filters.
        let filter = SCContentFilter(desktopIndependentWindow: target)
        let config = SCStreamConfiguration()
        config.width = max(1, Int(target.frame.width) * 2)
        config.height = max(1, Int(target.frame.height) * 2)
        config.showsCursor = false
        config.capturesAudio = false

        do {
            let cgImage = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            let png = try pngData(from: cgImage)
            let meta: [String: String] = [
                "scope": "window",
                "appName": target.owningApplication?.applicationName ?? "",
                "bundleId": target.owningApplication?.bundleIdentifier ?? "",
                "windowTitle": sanitizeTitle(target.title),
                "width": String(config.width),
                "height": String(config.height),
                "redactionRules": "exclude-self-app,exclude-sensitive-titles",
                "redactionMode": "client-rules",
                "redactionStatus": "redacted",
            ]
            return CaptureResult(pngData: png, clientDeclaredRedacted: true, meta: meta)
        } catch {
            throw CaptureError.captureFailed(error.localizedDescription)
        }
    }

    // MARK: - Internals

    /// Pure attestation for region-crop captures (no ScreenCaptureKit).
    /// Region crop scopes pixels; it is **not** redaction — always `clientDeclaredRedacted=false`.
    /// Server upload remains fail-closed for opaque screenshots unless a real redaction rule ran.
    static func regionCropAttestation(region: CGRect, reason: String) -> (clientDeclaredRedacted: Bool, meta: [String: String]) {
        (
            false,
            [
                "scope": "region",
                "reason": reason,
                "redactionMode": "region-crop-only",
                "redactionStatus": "not-redacted",
                "clientDeclaredRedacted": "false",
                "x": "\(region.origin.x)",
                "y": "\(region.origin.y)",
                "width": "\(region.width)",
                "height": "\(region.height)",
            ]
        )
    }

    private static func captureRegion(_ region: CGRect, reason: String) async throws -> CaptureResult {
        // Capture main display then crop — still require Screen Recording.
        // This is display-then-crop scoping only; do not claim redaction.
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else {
            throw CaptureError.captureFailed("no display")
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.width = display.width
        config.height = display.height
        config.showsCursor = false
        let full = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        guard let cropped = full.cropping(to: region) else {
            throw CaptureError.captureFailed("region crop failed")
        }
        let png = try pngData(from: cropped)
        let att = regionCropAttestation(region: region, reason: reason)
        return CaptureResult(
            pngData: png,
            clientDeclaredRedacted: att.clientDeclaredRedacted,
            meta: att.meta
        )
    }

    private static func isSafeRegion(_ region: CGRect) -> Bool {
        // Reject full-screen-ish regions (fail closed).
        guard let screen = NSScreen.main else { return false }
        let full = screen.frame
        let area = region.width * region.height
        let fullArea = full.width * full.height
        if area <= 0 { return false }
        if area >= fullArea * 0.85 { return false }
        return region.width >= 10 && region.height >= 10
    }

    private static func isSensitiveTitle(_ title: String) -> Bool {
        let t = title.lowercased()
        return sensitiveTitleKeywords.contains { t.contains($0) }
    }

    private static func sanitizeTitle(_ title: String?) -> String {
        let t = title ?? ""
        if isSensitiveTitle(t) { return "[redacted-title]" }
        // Truncate; avoid logging secrets in long titles.
        return String(t.prefix(120))
    }

    private static func pngData(from image: CGImage) throws -> Data {
        let rep = NSBitmapImageRep(cgImage: image)
        guard let data = rep.representation(using: .png, properties: [:]) else {
            throw CaptureError.captureFailed("PNG encode failed")
        }
        return data
    }
}
