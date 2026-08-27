//
//  MainView.swift
//  aios-system
//
//  Slim authenticated shell: connection, device-agent status, recent
//  device tasks, and a button that opens the web admin console.
//

import AppKit
import SwiftUI

/// Opens aios-web (default loopback :3100) in the system browser.
enum WebConsole {
    static var adminURL: URL {
        var c = URLComponents()
        c.scheme = AIOSConfig.httpBase.scheme ?? "http"
        c.host = AIOSConfig.httpBase.host ?? "127.0.0.1"
        c.port = 3100
        c.path = "/admin"
        return c.url ?? URL(string: "http://127.0.0.1:3100/admin")!
    }

    static func open() {
        NSWorkspace.shared.open(adminURL)
    }
}

struct MainView: View {
    @Environment(AppState.self) private var app

    private var device: DeviceAgentService { app.deviceAgent }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    connectionCard
                    deviceCard
                    recentTasksCard
                    openWebButton
                }
                .padding(20)
            }
            .navigationTitle("AIOS 裝置代理")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    NavigationLink {
                        SettingsView()
                    } label: {
                        Label("設定", systemImage: "gearshape")
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                windowFooter
            }
        }
    }

    // MARK: - Connection

    private var connectionCard: some View {
        StatusCard(title: "連線狀態") {
            LabeledContent("使用者 AWP") {
                StatusPill(
                    text: app.connected ? "已連線" : "未連線",
                    tone: app.connected ? .ok : .bad
                )
            }
            LabeledContent("帳號", value: app.user?.displayName ?? "—")
            LabeledContent("角色", value: app.user?.role ?? "—")
            LabeledContent("伺服器") {
                Text(AIOSConfig.serverBaseURLString)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
    }

    // MARK: - Device agent

    private var deviceCard: some View {
        StatusCard(title: "裝置代理") {
            LabeledContent("註冊") {
                StatusPill(
                    text: device.isEnrolled ? "已註冊" : "未註冊",
                    tone: device.isEnrolled ? .ok : .neutral
                )
            }
            LabeledContent("通道") {
                StatusPill(
                    text: device.connectionState.rawValue,
                    tone: deviceTone
                )
            }
            LabeledContent("裝置 ID") {
                Text(device.deviceId ?? "—")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .textSelection(.enabled)
            }
            if let err = device.lastError, !err.isEmpty {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            if !device.isEnrolled {
                Text("請到設定以一次性註冊碼把這台 Mac 登記為執行裝置。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let caps = device.lastCapabilities {
                HStack(spacing: 8) {
                    FeatureDot(label: "Computer Use", on: caps.features.computerUse)
                    FeatureDot(label: "截圖", on: caps.features.screenshot)
                    FeatureDot(label: "LINE", on: caps.features.lineDesktop)
                }
            }
        }
    }

    private var deviceTone: StatusPill.Tone {
        switch device.connectionState {
        case .online: return .ok
        case .connecting, .reconnecting: return .warn
        case .authFailed: return .bad
        case .disconnected: return .neutral
        }
    }

    // MARK: - Recent tasks

    private var recentTasksCard: some View {
        StatusCard(title: "最近裝置任務") {
            if device.taskLog.isEmpty {
                Text("尚無裝置任務")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(device.taskLog.prefix(12)) { entry in
                        DeviceTaskRow(entry: entry)
                    }
                }
            }
        }
    }

    // MARK: - Open web

    private var openWebButton: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                WebConsole.open()
            } label: {
                Label("開啟 Web 後台", systemImage: "safari")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            Text(WebConsole.adminURL.absoluteString)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Footer

    private var windowFooter: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 10) {
                Image(systemName: app.connected ? "bolt.fill" : "bolt.slash.fill")
                    .foregroundStyle(app.connected ? .green : .red)
                    .imageScale(.small)
                VStack(alignment: .leading, spacing: 1) {
                    Text(app.user?.displayName ?? "未登入")
                        .font(.caption)
                        .fontWeight(.medium)
                        .lineLimit(1)
                    Text(app.connected ? "使用者已連線" : "使用者未連線")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button(action: { app.logout() }) {
                    Image(systemName: "rectangle.portrait.and.arrow.right")
                }
                .buttonStyle(.plain)
                .help("登出")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .background(.bar)
    }
}

// MARK: - Pieces

private struct StatusCard<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 10).fill(.background.secondary))
    }
}

private struct StatusPill: View {
    enum Tone { case ok, warn, bad, neutral }
    let text: String
    let tone: Tone

    var body: some View {
        let color: Color = {
            switch tone {
            case .ok: return .green
            case .warn: return .orange
            case .bad: return .red
            case .neutral: return .secondary
            }
        }()
        Text(text)
            .font(.caption)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(color.opacity(0.15))
            .foregroundStyle(color)
            .clipShape(Capsule())
    }
}

private struct FeatureDot: View {
    let label: String
    let on: Bool

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(on ? Color.green : Color.red)
                .frame(width: 6, height: 6)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}

private struct DeviceTaskRow: View {
    let entry: DeviceTaskLogEntry

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
                .padding(.top, 5)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.message)
                    .font(.caption)
                    .lineLimit(2)
                HStack(spacing: 8) {
                    if let tid = entry.taskId {
                        Text(String(tid.prefix(10)) + "…")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Text(entry.at.formatted(date: .omitted, time: .standard))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
    }

    private var color: Color {
        switch entry.level {
        case .info: return .secondary
        case .warn: return .orange
        case .error: return .red
        case .success: return .green
        }
    }
}
