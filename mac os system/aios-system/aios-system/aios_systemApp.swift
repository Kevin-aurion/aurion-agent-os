//
//  aios_systemApp.swift
//  aios-system — local-first Agent OS macOS client + host device agent.
//

import AppKit
import SwiftUI

/// Compact default for the device-agent status window (not the old admin shell).
private enum DefaultWindowMetrics {
    static let size = CGSize(width: 520, height: 640)
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
                .frame(minWidth: 480, minHeight: 520)
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
