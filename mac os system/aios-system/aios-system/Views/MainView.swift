//
//  MainView.swift
//  aios-system
//
//  Root authenticated shell: NavigationSplitView with sidebar sections,
//  connection/user footer, and a Dashboard detail pane.
//

import SwiftUI

/// Top-level sidebar sections of the authenticated app shell.
enum MainSection: String, CaseIterable, Identifiable {
    case dashboard, agents, runs, settings

    var id: String { rawValue }

    var label: String {
        switch self {
        case .dashboard: return "總覽"
        case .agents: return "員工"
        case .runs: return "執行"
        case .settings: return "設定"
        }
    }

    var icon: String {
        switch self {
        case .dashboard: return "square.grid.2x2"
        case .agents: return "person.2.fill"
        case .runs: return "play.circle"
        case .settings: return "gearshape"
        }
    }
}

struct MainView: View {
    @Environment(AppState.self) private var app
    @State private var selection: MainSection? = .dashboard

    var body: some View {
        NavigationSplitView {
            List(MainSection.allCases, selection: $selection) { section in
                Label(section.label, systemImage: section.icon)
                    .tag(section)
            }
            .navigationTitle("AIOS")
            .safeAreaInset(edge: .bottom) {
                SidebarFooter()
            }
        } detail: {
            NavigationStack {
                detailView
            }
        }
    }

    @ViewBuilder
    private var detailView: some View {
        switch selection ?? .dashboard {
        case .dashboard: DashboardPane()
        case .agents: AgentsView()
        case .runs: RunsView()
        case .settings: SettingsView()
        }
    }
}

/// Sidebar footer: realtime connection indicator + current user + logout.
private struct SidebarFooter: View {
    @Environment(AppState.self) private var app

    var body: some View {
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
                Text(app.connected ? "已連線" : "未連線")
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
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

// MARK: - Dashboard

/// Loose shape for GET /api/dashboard/summary — fields are optional since the
/// exact backend payload may grow; missing keys simply render as placeholders.
private struct DashboardSummary: Decodable {
    let agentCount: Int?
    let activeAgents: Int?
    let activeRuns: Int?
    let runsToday: Int?
    let pendingSkillReviews: Int?
    let integrationsConnected: Int?
    let workflowCount: Int?
}

/// Dashboard/overview pane: quick stat tiles from the summary endpoint plus a
/// compact live activity feed sourced from `app.activity`.
struct DashboardPane: View {
    @Environment(AppState.self) private var app
    @State private var summary: DashboardSummary?
    @State private var loadError: String?
    @State private var loading = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                statGrid

                if let loadError {
                    Text(loadError)
                        .font(.caption)
                        .foregroundStyle(.red)
                }

                enginesSection

                Divider()

                activitySection
            }
            .padding(20)
        }
        .navigationTitle("總覽")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(action: { Task { await load() } }) {
                    Label("重新整理", systemImage: "arrow.clockwise")
                }
                .disabled(loading)
            }
        }
        .task { await load() }
    }

    private var statGrid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 160), spacing: 12)], spacing: 12) {
            StatTile(title: "員工數", value: summary?.agentCount, systemImage: "person.2.fill")
            StatTile(title: "執行中", value: summary?.activeRuns, systemImage: "play.circle.fill")
            StatTile(title: "今日執行", value: summary?.runsToday, systemImage: "calendar")
            StatTile(title: "待審技能", value: summary?.pendingSkillReviews, systemImage: "checkmark.seal")
            StatTile(title: "已連線整合", value: summary?.integrationsConnected, systemImage: "link")
            StatTile(title: "工作流程", value: summary?.workflowCount, systemImage: "flowchart")
        }
    }

    private var enginesSection: some View {
        Group {
            if let preflight = app.preflight {
                VStack(alignment: .leading, spacing: 8) {
                    Text("執行引擎").font(.headline)
                    HStack(spacing: 16) {
                        EngineBadge(name: "Claude", engine: preflight.engines.claude)
                        EngineBadge(name: "Codex", engine: preflight.engines.codex)
                    }
                }
            }
        }
    }

    private var activitySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("即時動態").font(.headline)
            if app.activity.isEmpty {
                Text("尚無動態").font(.caption).foregroundStyle(.secondary)
            } else {
                VStack(spacing: 0) {
                    ForEach(app.activity.prefix(20)) { item in
                        ActivityRow(item: item)
                        if item.id != app.activity.prefix(20).last?.id {
                            Divider()
                        }
                    }
                }
                .background(RoundedRectangle(cornerRadius: 8).fill(.background.secondary))
            }
        }
    }

    private func load() async {
        loading = true
        loadError = nil
        do {
            summary = try await APIClient.shared.request("/api/dashboard/summary")
        } catch let e as APIClient.APIError {
            loadError = e.message
        } catch {
            loadError = "無法載入總覽資料"
        }
        loading = false
    }
}

private struct StatTile: View {
    let title: String
    let value: Int?
    let systemImage: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: systemImage).foregroundStyle(.tint)
                Spacer()
            }
            Text(value.map(String.init) ?? "—")
                .font(.title).bold()
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(.background.secondary))
    }
}

private struct EngineBadge: View {
    let name: String
    let engine: Preflight.Engine

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(engine.installed ? .green : .red)
                .frame(width: 8, height: 8)
            Text(name).font(.caption).fontWeight(.medium)
            if let version = engine.version {
                Text(version).font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 6).fill(.background.secondary))
    }
}

private struct ActivityRow: View {
    let item: AppState.ActivityItem

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.text).font(.caption).lineLimit(2)
                Text(item.topic).font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
            Text(item.at, style: .time)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}
