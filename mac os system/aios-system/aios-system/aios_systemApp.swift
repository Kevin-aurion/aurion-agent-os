//
//  aios_systemApp.swift
//  aios-system — local-first Agent OS macOS client + host agent runner.
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

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(app)
                .frame(minWidth: 1000, minHeight: 700)
                .task { await app.boot() }
        }
        .defaultSize(width: defaultWindowSize.width, height: defaultWindowSize.height)
        .windowStyle(.titleBar)

        // Menu-bar presence: live connection + recent activity.
        MenuBarExtra("AIOS", systemImage: app.connected ? "bolt.horizontal.circle.fill" : "bolt.horizontal.circle") {
            MenuBarView()
                .environment(app)
        }
        .menuBarExtraStyle(.window)
    }
}
