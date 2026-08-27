//
//  ContentView.swift
//  aios-system
//

import SwiftUI

struct ContentView: View {
    @Environment(AppState.self) private var app

    var body: some View {
        Group {
            if app.booting {
                ProgressView("連線中…").controlSize(.large)
            } else if app.user == nil {
                LoginView()
            } else {
                MainView()
            }
        }
        .frame(minWidth: 480, minHeight: 520)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
