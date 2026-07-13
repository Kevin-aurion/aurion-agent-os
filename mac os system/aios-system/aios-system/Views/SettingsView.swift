import SwiftUI

/// 設定：整合狀態（第三方帳號連結）與系統健康狀態。
/// 帳號連結（OAuth）需在瀏覽器完成，此畫面僅顯示目前狀態，並引導使用者至網頁版操作。
struct SettingsView: View {
    @Environment(AppState.self) private var app

    @State private var integrations: IntegrationsResponse?
    @State private var health: JSONValue?
    @State private var loading = false
    @State private var errorText = ""
    @State private var lastRefreshed: Date?

    var body: some View {
        Form {
            Section("帳號") {
                LabeledContent("使用者", value: app.user?.displayName ?? "—")
                LabeledContent("Email", value: app.user?.email ?? "—")
                LabeledContent("角色", value: app.user?.role ?? "—")
                Button("登出", role: .destructive) { app.logout() }
            }

            Section {
                if let integrations {
                    integrationRow(name: "Microsoft", configured: integrations.configured.microsoft)
                    integrationRow(name: "Google", configured: integrations.configured.google)
                    integrationRow(name: "LINE", configured: integrations.configured.line)
                } else {
                    Text(loading ? "載入中…" : "尚未載入整合狀態").foregroundStyle(.secondary)
                }
            } header: {
                Text("第三方整合")
            } footer: {
                Text("帳號連結（OAuth 授權）需在瀏覽器中完成，請於網頁版管理介面新增或移除帳號。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let integrations, !integrations.accounts.isEmpty {
                Section("已連結帳號") {
                    ForEach(integrations.accounts) { account in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(account.email).font(.body)
                                Text(account.provider).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            statusBadge(account.status)
                        }
                    }
                }
            }

            Section("系統健康") {
                LabeledContent("AIOS 連線") {
                    statusBadge(app.connected ? "connected" : "disconnected")
                }
                if let preflight = app.preflight {
                    LabeledContent("Claude Engine") {
                        engineValue(preflight.engines.claude)
                    }
                    LabeledContent("Codex Engine") {
                        engineValue(preflight.engines.codex)
                    }
                    LabeledContent("Grok Engine") {
                        engineValue(preflight.engines.grok)
                    }
                } else {
                    Text(loading ? "載入中…" : "尚無 Preflight 資料").foregroundStyle(.secondary)
                }
            }

            if let health {
                Section("後端健康檢查 (/api/health)") {
                    healthRows(health)
                }
            }

            if !errorText.isEmpty {
                Section {
                    Text(errorText).foregroundStyle(.red).font(.caption)
                }
            }

            if let lastRefreshed {
                Section {
                    Text("上次更新：\(lastRefreshed.formatted(date: .omitted, time: .standard))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("設定")
        .toolbar {
            ToolbarItem {
                Button {
                    Task { await refresh() }
                } label: {
                    if loading { ProgressView().controlSize(.small) }
                    else { Label("重新整理", systemImage: "arrow.clockwise") }
                }
                .disabled(loading)
            }
        }
        .task { await refresh() }
    }

    @ViewBuilder
    private func integrationRow(name: String, configured: Bool) -> some View {
        LabeledContent(name) {
            HStack(spacing: 6) {
                Circle()
                    .fill(configured ? .green : .secondary)
                    .frame(width: 8, height: 8)
                Text(configured ? "已設定" : "未設定")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func engineValue(_ engine: Preflight.Engine) -> some View {
        HStack(spacing: 6) {
            Circle()
                .fill(engine.installed ? .green : .red)
                .frame(width: 8, height: 8)
            Text(engine.installed ? (engine.version ?? "已安裝") : "未安裝")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func statusBadge(_ status: String) -> some View {
        let ok = ["active", "ok", "connected", "healthy"].contains(status.lowercased())
        Text(status)
            .font(.caption)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background((ok ? Color.green : Color.orange).opacity(0.15))
            .foregroundStyle(ok ? .green : .orange)
            .clipShape(Capsule())
    }

    @ViewBuilder
    private func healthRows(_ value: JSONValue) -> some View {
        if case .object(let obj) = value {
            ForEach(obj.keys.sorted(), id: \.self) { key in
                LabeledContent(key) {
                    Text(displayString(obj[key]))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        } else {
            Text(displayString(value)).font(.caption).foregroundStyle(.secondary)
        }
    }

    private func displayString(_ value: JSONValue?) -> String {
        guard let value else { return "—" }
        switch value {
        case .string(let s): return s
        case .number(let n): return n == n.rounded() ? String(Int(n)) : String(n)
        case .bool(let b): return b ? "true" : "false"
        case .null: return "—"
        case .array(let a): return "\(a.count) 項"
        case .object(let o): return "\(o.count) 個欄位"
        }
    }

    private func refresh() async {
        loading = true
        errorText = ""
        async let integrationsResult: IntegrationsResponse? = try? APIClient.shared.request("/api/integrations")
        async let healthResult: JSONValue? = try? APIClient.shared.request("/api/health")
        async let preflightResult: Preflight? = try? APIClient.shared.request("/api/preflight")

        integrations = await integrationsResult
        health = await healthResult
        if let preflight = await preflightResult { app.preflight = preflight }

        if integrations == nil { errorText = "無法載入整合狀態" }
        loading = false
        lastRefreshed = Date()
    }
}

/// GET /api/integrations 回應。
private struct IntegrationsResponse: Decodable {
    struct Account: Decodable, Identifiable {
        let id: String
        let provider: String
        let email: String
        let status: String
    }
    struct Configured: Decodable {
        let microsoft: Bool
        let google: Bool
        let line: Bool
    }
    let accounts: [Account]
    let configured: Configured
}
