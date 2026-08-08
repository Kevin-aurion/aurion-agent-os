import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// Honest capability probe — never fakes a feature that is not actually present.
nonisolated enum DeviceCapabilitiesProbe {
    struct ProbeDetail: Sendable {
        var osVersion: String
        var appVersion: String
        var codexAppPath: String?
        var codexCLIPath: String?
        var computerUseBridgePath: String?
        var lineDesktopPath: String?
        var nodePath: String?
        var screenRecordingGranted: Bool
        var accessibilityTrusted: Bool
        var notes: [String]
    }

    static func probe(includeMcp: Bool = true) -> (DeviceCapabilitiesDocument, ProbeDetail) {
        var notes: [String] = []
        let osVersion = ProcessInfo.processInfo.operatingSystemVersionString
        let appVersion = AIOSConfig.appVersion

        let codexApp = findApp(bundleIds: AIOSConfig.codexAppBundleIds)
            ?? findPathIfExists(AIOSConfig.computerUseAppPath)
        let lineApp = findApp(bundleIds: AIOSConfig.lineDesktopBundleIds)
        let codexCLI = findExecutable(
            knownPaths: AIOSConfig.knownCodexCLIPaths,
            name: "codex"
        )
        let bridgePath = FileManager.default.isExecutableFile(atPath: AIOSConfig.computerUseBridgePath)
            ? AIOSConfig.computerUseBridgePath
            : nil
        let nodePath = findExecutable(knownPaths: AIOSConfig.knownNodePaths, name: "node")

        let screenRecording = CGPreflightScreenCaptureAccess()
        let accessibility = AXIsProcessTrusted()

        // computerUse requires bridge binary + codex app host present.
        // Do not claim true from CLI alone (ADR 0005: Computer Use is App-hosted).
        let computerUse = bridgePath != nil && codexApp != nil
        let screenshotCapable = screenRecording // capture API requires Screen Recording
        if !screenRecording {
            notes.append("Screen Recording not granted — screenshot/checkpoint capture disabled")
        }
        if !accessibility {
            notes.append("Accessibility not granted — LINE Desktop MCP / AX automation limited")
        }
        if bridgePath == nil {
            notes.append("Codex Computer Use bridge binary not found at fixed path")
        }
        if codexApp == nil {
            notes.append("Codex / ChatGPT App bundle not found")
        }
        if codexCLI == nil {
            notes.append("codex CLI not found in known paths or PATH")
        }
        if lineApp == nil {
            notes.append("LINE Desktop app not found")
        }
        if nodePath == nil {
            notes.append("Node.js not found (required for line-desktop-mcp stdio)")
        }

        var mcpServers: [DeviceMcpServerCapability] = []
        if includeMcp {
            if let ready = LineDesktopMcpRuntime.probeReadyInstallation() {
                mcpServers.append(ready)
            }
        }

        let features = DeviceCapabilitiesDocument.DeviceFeatureFlags(
            computerUse: computerUse,
            screenRecording: screenRecording,
            accessibility: accessibility,
            screenshot: screenshotCapable,
            codexApp: codexApp != nil,
            codexCli: codexCLI != nil,
            lineDesktop: lineApp != nil
        )

        let doc = DeviceCapabilitiesDocument(
            platform: "MACOS",
            osVersion: osVersion,
            appVersion: appVersion,
            features: features,
            mcpServers: mcpServers,
            updatedAt: ISO8601DateFormatter().string(from: Date())
        )

        let detail = ProbeDetail(
            osVersion: osVersion,
            appVersion: appVersion,
            codexAppPath: codexApp,
            codexCLIPath: codexCLI,
            computerUseBridgePath: bridgePath,
            lineDesktopPath: lineApp,
            nodePath: nodePath,
            screenRecordingGranted: screenRecording,
            accessibilityTrusted: accessibility,
            notes: notes
        )
        return (doc, detail)
    }

    /// Request Screen Recording (may show system prompt once).
    @MainActor
    static func requestScreenRecordingAccess() -> Bool {
        // CGRequestScreenCaptureAccess prompts if not determined.
        CGRequestScreenCaptureAccess()
    }

    /// Open System Settings panes for permissions guidance.
    @MainActor
    static func openPermissionSettings(kind: PermissionKind) {
        let urlString: String
        switch kind {
        case .screenRecording:
            urlString = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        case .accessibility:
            urlString = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        }
        if let url = URL(string: urlString) {
            NSWorkspace.shared.open(url)
        }
    }

    enum PermissionKind {
        case screenRecording
        case accessibility
    }

    // MARK: - Discovery helpers

    private static func findApp(bundleIds: [String]) -> String? {
        for bid in bundleIds {
            if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bid) {
                return url.path
            }
        }
        return nil
    }

    private static func findPathIfExists(_ path: String) -> String? {
        FileManager.default.fileExists(atPath: path) ? path : nil
    }

    private static func findExecutable(knownPaths: [String], name: String) -> String? {
        let fm = FileManager.default
        for p in knownPaths {
            if fm.isExecutableFile(atPath: p) { return p }
        }
        // PATH lookup (do not execute untrusted names — fixed name only).
        if let pathEnv = ProcessInfo.processInfo.environment["PATH"] {
            for dir in pathEnv.split(separator: ":") {
                let candidate = "\(dir)/\(name)"
                if fm.isExecutableFile(atPath: candidate) { return candidate }
            }
        }
        return nil
    }
}
