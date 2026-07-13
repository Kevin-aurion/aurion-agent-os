//
//  aios_systemApp.swift
//  aios-system — local-first Agent OS macOS client + host agent runner.
//

import SwiftUI

@main
struct aios_systemApp: App {
    @State private var app = AppState()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(app)
                .frame(minWidth: 900, minHeight: 600)
                .task { await app.boot() }
        }
        .windowStyle(.titleBar)

        // Menu-bar presence: live connection + recent activity.
        MenuBarExtra("AIOS", systemImage: app.connected ? "bolt.horizontal.circle.fill" : "bolt.horizontal.circle") {
            MenuBarView()
                .environment(app)
        }
        .menuBarExtraStyle(.window)
    }
}
