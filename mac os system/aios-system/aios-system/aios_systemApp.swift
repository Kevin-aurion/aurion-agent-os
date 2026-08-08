//
//  aios_systemApp.swift
//  aios-system — local-first Agent OS macOS client + host device agent.
//

import AppKit
import SwiftUI

/// Default window size ≈ 72% of the main screen's visible frame.
private enum DefaultWindowMetrics {
    static let size: CGSize = {
        if let screen = NSScreen.main {
            let visible = screen.visibleFrame.size
            return CGSize(
                width: max(1000, visible.width * 0.72),
                height: max(700, visible.height * 0.72)
            )
        }
        return CGSize(width: 1280, height: 860)
    }()
}

@main
struct aios_systemApp: App {
    @State private var app = AppState()
    private let defaultWindowSize = DefaultWindowMetrics.size

    init() {
        // Headless pure self-tests: `aios-system --self-test` exits before UI.
        Self.exitIfSelfTestRequested()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(app)
                .frame(minWidth: 1000, minHeight: 700)
                .task { await app.boot() }
        }
        .defaultSize(width: defaultWindowSize.width, height: defaultWindowSize.height)
        .windowStyle(.titleBar)

        MenuBarExtra("AIOS", systemImage: app.connected ? "bolt.horizontal.circle.fill" : "bolt.horizontal.circle") {
            MenuBarView()
                .environment(app)
        }
        .menuBarExtraStyle(.window)
    }

    /// If argv contains `--self-test` or `-self-test`, run pure validators and exit.
    private static func exitIfSelfTestRequested() {
        let args = ProcessInfo.processInfo.arguments
        guard args.contains("--self-test") || args.contains("-self-test") else { return }
        let code = DeviceAgentSelfTest.runAndReportToStdout()
        // Flush and terminate without launching UI scenes.
        fflush(stdout)
        fflush(stderr)
        Darwin.exit(code)
    }
}
