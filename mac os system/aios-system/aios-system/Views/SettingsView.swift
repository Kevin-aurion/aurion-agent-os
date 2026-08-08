import SwiftUI

/// 設定：伺服器 URL、裝置註冊、能力探測、整合狀態與系統健康。
struct SettingsView: View {
    @Environment(AppState.self) private var app

    @State private var serverURL: String = AIOSConfig.serverBaseURLString
    @State private var enrollCode: String = ""
    @State private var integrations: IntegrationsResponse?
    @State private var health: JSONValue?
    @State private var loading = false
    @State private var enrolling = false
    @State private var errorText = ""
    @State private var enrollMessage = ""
    @State private var lastRefreshed: Date?
    @State private var selfTestResults: [DeviceAgentSelfTest.Result] = []
    @State private var showForgetConfirm = false

    private var device: DeviceAgentService { app.deviceAgent }

    var body: some View {
        Form {
            Section("伺服器") {
                TextField("Base URL (http/https)", text: $serverURL)
                    .textFieldStyle(.roundedBorder)
                Text("預設 \(AIOSConfig.defaultServerBaseURL)。會推導 ws/wss。裝置 token 絕不進 URL。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("儲存伺服器位址") {
                    saveServerURL()
                }
            }

            Section {
                LabeledContent("註冊狀態") {
                    Text(device.isEnrolled ? "已註冊" : "未註冊")
                        .foregroundStyle(device.isEnrolled ? .green : .secondary)
                }
                LabeledContent("裝置 ID", value: device.deviceId ?? "—")
                LabeledContent("連線") {
                    deviceStateBadge
                }
                if let err = device.lastError, !err.isEmpty {
                    Text(err).font(.caption).foregroundStyle(.red)
                }

                if !device.isEnrolled {
                    SecureField("一次性註冊碼", text: $enrollCode)
                        .textFieldStyle(.roundedBorder)
                    Button {
                        Task { await enroll() }
                    } label: {
                        if enrolling { ProgressView().controlSize(.small) }
                        else { Text("註冊此 Mac 為執行裝置") }
                    }
                    .disabled(enrolling || enrollCode.trimmingCharacters(in: .whitespacesAndNewlines).count < 16)
                } else {
                    Button("回報能力 (capabilities)") {
                        Task { await device.probeAndReport() }
                    }
                    Button("權限指引：螢幕錄製") {
                        device.requestPermissionGuidance(kind: .screenRecording)
                    }
                    Button("權限指引：輔助使用") {
                        device.requestPermissionGuidance(kind: .accessibility)
                    }
                    Button("中斷並清除裝置憑證", role: .destructive) {
                        Task { await device.disconnectAndForget() }
                    }
                }

                if !enrollMessage.isEmpty {
                    Text(enrollMessage).font(.caption).foregroundStyle(.secondary)
                }
            } header: {
                Text("裝置代理 (Device Agent)")
            } footer: {
                Text("裝置憑證存獨立 Keychain service，與使用者 JWT 分離。註冊碼由 FDE 在管理介面產生。")
                    .font(.caption)
            }

            if let caps = device.lastCapabilities {
                Section("能力報告") {
                    LabeledContent("platform", value: caps.platform)
                    LabeledContent("osVersion", value: caps.osVersion)
                    LabeledContent("appVersion", value: caps.appVersion)
                    featureRow("computerUse", caps.features.computerUse)
                    featureRow("screenRecording", caps.features.screenRecording)
                    featureRow("accessibility", caps.features.accessibility)
                    featureRow("screenshot", caps.features.screenshot)
                    featureRow("codexApp", caps.features.codexApp)
                    featureRow("codexCli", caps.features.codexCli)
                    featureRow("lineDesktop", caps.features.lineDesktop)
                    if !caps.mcpServers.isEmpty {
                        ForEach(caps.mcpServers, id: \.name) { s in
                            LabeledContent("MCP \(s.name)") {
                                Text("\(s.version) tools=\(s.tools.count)")
                                    .font(.caption)
                            }
                        }
                    }
                    if !device.probeNotes.isEmpty {
                        ForEach(device.probeNotes, id: \.self) { note in
                            Text("• \(note)")
                                .font(.caption2)
                                .foregroundStyle(.orange)
                        }
                    }
                }
            }

            Section("本機任務日誌") {
                if device.taskLog.isEmpty {
                    Text("尚無裝置任務").foregroundStyle(.secondary)
                } else {
                    ForEach(device.taskLog.prefix(30)) { entry in
                        HStack(alignment: .top) {
                            Circle()
                                .fill(logColor(entry.level))
                                .frame(width: 6, height: 6)
                                .padding(.top, 5)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(entry.message)
                                    .font(.caption)
                                    .lineLimit(3)
                                HStack {
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
                        }
                    }
                }
            }

            Section("開發自檢 (pure validators)") {
                Button("Run self-tests") {
                    selfTestResults = DeviceAgentSelfTest.runAll()
                }
                if !selfTestResults.isEmpty {
                    let pass = selfTestResults.filter(\.passed).count
                    Text("\(pass)/\(selfTestResults.count) passed")
                        .font(.caption)
                        .foregroundStyle(pass == selfTestResults.count ? .green : .red)
                    ForEach(selfTestResults, id: \.name) { r in
                        HStack {
                            Image(systemName: r.passed ? "checkmark.circle.fill" : "xmark.circle.fill")
                                .foregroundStyle(r.passed ? .green : .red)
                            Text(r.name).font(.caption)
                            Spacer()
                            Text(r.detail).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
            }

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
                LabeledContent("使用者 AWP") {
                    statusBadge(app.connected ? "connected" : "disconnected")
                }
                LabeledContent("裝置通道") {
                    statusBadge(device.isOnline ? "online" : device.connectionState.rawValue)
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
        .task {
            serverURL = AIOSConfig.serverBaseURLString
            await refresh()
            if device.isEnrolled {
                await device.probeAndReport()
            }
        }
    }

    // MARK: - Device helpers

    @ViewBuilder
    private var deviceStateBadge: some View {
        let s = device.connectionState
        let color: Color = {
            switch s {
            case .online: return .green
            case .connecting, .reconnecting: return .orange
            case .authFailed: return .red
            case .disconnected: return .secondary
            }
        }()
        Text(s.rawValue)
            .font(.caption)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(color.opacity(0.15))
            .foregroundStyle(color)
            .clipShape(Capsule())
    }

    private func featureRow(_ name: String, _ on: Bool) -> some View {
        LabeledContent(name) {
            HStack(spacing: 6) {
                Circle().fill(on ? Color.green : Color.red).frame(width: 8, height: 8)
                Text(on ? "true" : "false").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func logColor(_ level: DeviceTaskLogEntry.Level) -> Color {
        switch level {
        case .info: return .secondary
        case .warn: return .orange
        case .error: return .red
        case .success: return .green
        }
    }

    private func saveServerURL() {
        errorText = ""
        enrollMessage = ""
        guard AIOSConfig.validatedHTTPBase(serverURL) != nil else {
            errorText = "無效的伺服器 URL（需 http:// 或 https://）"
            return
        }
        AIOSConfig.serverBaseURLString = serverURL
        enrollMessage = "已儲存 \(AIOSConfig.serverBaseURLString)"
        // Reconnect device channel against new base if enrolled.
        if device.isEnrolled {
            Task {
                await device.stop()
                await device.startIfEnrolled()
            }
        }
    }

    private func enroll() async {
        enrolling = true
        errorText = ""
        enrollMessage = ""
        defer { enrolling = false }
        if AIOSConfig.validatedHTTPBase(serverURL) == nil {
            errorText = "請先設定有效的伺服器 URL"
            return
        }
        AIOSConfig.serverBaseURLString = serverURL
        do {
            try await device.enroll(code: enrollCode, serverURL: serverURL)
            enrollCode = ""
            enrollMessage = "註冊成功。裝置 token 已存入 Keychain（不會顯示）。"
            await device.probeAndReport()
        } catch {
            errorText = error.localizedDescription
        }
    }

    // MARK: - Existing UI helpers

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
        let ok = ["active", "ok", "connected", "healthy", "online"].contains(status.lowercased())
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
