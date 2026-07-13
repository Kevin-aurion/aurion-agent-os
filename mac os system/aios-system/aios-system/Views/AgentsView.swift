//
//  AgentsView.swift
//  aios-system
//
//  員工 (Agents) — master/detail。詳情採分頁：概況 / 技能 / 雲端檔案 /
//  工作流 / 執行紀錄 / 訓練 / 對話（對話與即時 run 時間軸原樣保留）。
//

import SwiftUI

// MARK: - Local wire types

/// Flat shape from GET /api/runs/:id (run fields + steps).
private struct AgentRunDetail: Decodable {
    let id: String
    let status: String
    let steps: [RunStepRow]
}

private struct SendMessageResult: Decodable {
    let messageId: String
    let runId: String
}

private let terminalRunStatuses: Set<String> = [
    "completed", "success", "succeeded", "failed", "error",
    "cancelled", "canceled", "awaiting_review",
]

private let engineOptions: [(label: String, value: String)] = [
    ("Claude Code", "CLAUDE_CODE"),
    ("Codex", "CODEX"),
    ("Grok", "GROK"),
]

// MARK: - AgentsView

struct AgentsView: View {
    @Environment(AppState.self) private var app

    @State private var agents: [Agent] = []
    @State private var selectedAgentID: String?
    @State private var loading = false
    @State private var errorText = ""
    @State private var showCreate = false

    var body: some View {
        HSplitView {
            // 左：員工清單
            VStack(spacing: 0) {
                Group {
                    if loading && agents.isEmpty {
                        ProgressView("載入員工…").frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else if agents.isEmpty {
                        ContentUnavailableView(
                            "尚無員工",
                            systemImage: "person.2",
                            description: Text("點擊右上角「＋」建立第一位員工")
                        )
                    } else {
                        List(agents, selection: $selectedAgentID) { agent in
                            AgentRow(agent: agent).tag(agent.id)
                        }
                        .listStyle(.sidebar)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                if !errorText.isEmpty {
                    Text(errorText)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .frame(minWidth: 260, idealWidth: 280, maxWidth: 340)

            // 右：詳情
            Group {
                if let id = selectedAgentID, let agent = agents.first(where: { $0.id == id }) {
                    AgentDetailView(agent: agent) {
                        Task { await loadAgents() }
                    }
                } else {
                    ContentUnavailableView(
                        "選擇一位員工",
                        systemImage: "person.crop.circle",
                        description: Text("從左側清單選擇以查看詳情與對話")
                    )
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .navigationTitle("員工")
        .toolbar {
            ToolbarItem {
                Button { showCreate = true } label: {
                    Label("新增員工", systemImage: "plus")
                }
            }
            ToolbarItem {
                Button { Task { await loadAgents() } } label: {
                    Label("重新整理", systemImage: "arrow.clockwise")
                }
                .disabled(loading)
            }
        }
        .task { await loadAgents() }
        .sheet(isPresented: $showCreate) {
            CreateAgentSheet { newAgent in
                agents.insert(newAgent, at: 0)
                selectedAgentID = newAgent.id
            }
        }
    }

    private func loadAgents() async {
        loading = true
        do {
            agents = try await APIClient.shared.request("/api/agents")
            errorText = ""
        } catch let e as APIClient.APIError {
            errorText = e.message
        } catch {
            errorText = "載入員工失敗"
        }
        loading = false
    }
}

// MARK: - Agent row

private struct AgentRow: View {
    let agent: Agent

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "person.crop.circle.fill")
                .font(.title2)
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(agent.name).font(.body).bold()
                Text(agent.description).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            AgentStatusBadge(status: agent.status)
        }
        .padding(.vertical, 2)
    }
}

private struct AgentStatusBadge: View {
    let status: String

    private var color: Color {
        switch status.lowercased() {
        case "active", "running", "online": return .green
        case "paused", "idle": return .orange
        case "error", "failed", "archived": return .red
        default: return .secondary
        }
    }

    var body: some View {
        Text(status)
            .font(.caption2).bold()
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }
}

// MARK: - Detail tabs

private enum AgentDetailTab: String, CaseIterable, Identifiable {
    case overview, skills, files, workflows, runs, train, chat

    var id: String { rawValue }

    var label: String {
        switch self {
        case .overview: return "概況"
        case .skills: return "技能"
        case .files: return "雲端檔案"
        case .workflows: return "工作流"
        case .runs: return "執行紀錄"
        case .train: return "訓練"
        case .chat: return "對話"
        }
    }
}

// MARK: - AgentDetailView (tab shell)

struct AgentDetailView: View {
    let agent: Agent
    var onUpdated: () -> Void = {}

    @State private var detail: AgentDetail?
    @State private var tab: AgentDetailTab = .overview
    @State private var loading = false
    @State private var errorText = ""
    @State private var showEdit = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Horizontal scroll keeps 7 Chinese segments readable on narrow panes
            // without switching away from segmented style.
            ScrollView(.horizontal, showsIndicators: false) {
                Picker("分頁", selection: $tab) {
                    ForEach(AgentDetailTab.allCases) { t in
                        Text(t.label).tag(t)
                    }
                }
                .pickerStyle(.segmented)
                .frame(minWidth: 560)
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 8)

            if !errorText.isEmpty {
                Text(errorText)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 16)
            }

            Group {
                if loading && detail == nil {
                    ProgressView("載入員工詳情…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let detail {
                    tabContent(detail)
                } else {
                    ContentUnavailableView(
                        "無法載入詳情",
                        systemImage: "exclamationmark.triangle",
                        description: Text(errorText.isEmpty ? "請重新整理" : errorText)
                    )
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .navigationTitle(detail?.name ?? agent.name)
        .toolbar {
            ToolbarItem {
                Button { Task { await loadDetail() } } label: {
                    Label("重新整理", systemImage: "arrow.clockwise")
                }
                .disabled(loading)
            }
            if tab == .overview {
                ToolbarItem {
                    Button("編輯") { showEdit = true }
                        .disabled(detail == nil)
                }
            }
        }
        .task(id: agent.id) {
            tab = .overview
            detail = nil
            await loadDetail()
        }
        .sheet(isPresented: $showEdit) {
            if let detail {
                EditAgentSheet(detail: detail) {
                    Task {
                        await loadDetail()
                        onUpdated()
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func tabContent(_ detail: AgentDetail) -> some View {
        switch tab {
        case .overview:
            AgentOverviewTab(detail: detail, onEdit: { showEdit = true })
        case .skills:
            AgentSkillsTab(agentId: detail.id, mounted: detail.skills) {
                Task { await loadDetail(); onUpdated() }
            }
        case .files:
            AgentFilesTab(targets: detail.fileTargets)
        case .workflows:
            AgentWorkflowsTab(agentId: detail.id)
        case .runs:
            AgentRunsTab(agentId: detail.id)
        case .train:
            AgentTrainTab(agentName: detail.name)
        case .chat:
            AgentChatPane(agentId: detail.id, agentName: detail.name)
        }
    }

    private func loadDetail() async {
        loading = true
        errorText = ""
        do {
            detail = try await APIClient.shared.request("/api/agents/\(agent.id)")
        } catch let e as APIClient.APIError {
            errorText = e.message
        } catch {
            errorText = "載入員工詳情失敗"
        }
        loading = false
    }
}

// MARK: - Overview tab

private struct AgentOverviewTab: View {
    let detail: AgentDetail
    let onEdit: () -> Void

    private var restrictions: Restrictions {
        detail.restrictions ?? .defaults
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text("概況").font(.headline)
                    Spacer()
                    Button("編輯", action: onEdit)
                }

                GroupBox {
                    VStack(alignment: .leading, spacing: 10) {
                        metaRow("名稱", detail.name)
                        HStack {
                            Text("狀態").foregroundStyle(.secondary)
                            Spacer()
                            AgentStatusBadge(status: detail.status)
                        }
                        metaRow("部門", detail.department ?? "—")
                        metaRow("Slug", detail.slug ?? "—")
                        metaRow("執行引擎", engineLabel(detail.engineExecute))
                        metaRow(
                            "驗證引擎",
                            detail.engineVerify.map(engineLabel) ?? "自動"
                        )
                        metaRow("最大回合數", detail.maxRounds.map(String.init) ?? "—")
                        Divider()
                        Text(detail.description)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(6)
                }

                GroupBox {
                    VStack(alignment: .leading, spacing: 10) {
                        if let prompt = detail.rolePrompt, !prompt.isEmpty {
                            Text(prompt)
                                .font(.callout)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        } else {
                            Text("尚未設定角色提示詞")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(4)
                } label: {
                    Text("角色提示詞")
                }

                GroupBox {
                    VStack(alignment: .leading, spacing: 10) {
                        LazyVGrid(
                            columns: [GridItem(.adaptive(minimum: 120), spacing: 8)],
                            spacing: 8
                        ) {
                            RestrictionBadge(title: "網路搜尋", on: restrictions.webSearch)
                            RestrictionBadge(title: "電腦操控", on: restrictions.computerUse)
                            RestrictionBadge(title: "寄信", on: restrictions.sendEmail)
                            RestrictionBadge(title: "雲端寫入", on: restrictions.cloudWrite)
                            RestrictionBadge(title: "Shell", on: restrictions.shell)
                        }
                        if let notes = restrictions.notes, !notes.isEmpty {
                            Divider()
                            Text("備註：\(notes)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(4)
                } label: {
                    Text("能力限制")
                }

                HStack(spacing: 16) {
                    Label("技能 \(detail.skills.count)", systemImage: "wrench.and.screwdriver")
                    Label("工作流 \(detail.workflows.count)", systemImage: "arrow.triangle.branch")
                    Label("檔案 \(detail.fileTargets.count)", systemImage: "doc.on.doc")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            .padding(20)
        }
    }

    private func metaRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: true, vertical: false)
            Spacer(minLength: 12)
            Text(value)
                .multilineTextAlignment(.trailing)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .font(.callout)
    }

    private func engineLabel(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else { return "—" }
        return engineOptions.first(where: { $0.value == raw })?.label ?? raw
    }
}

private struct RestrictionBadge: View {
    let title: String
    let on: Bool

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(on ? Color.green : Color.secondary.opacity(0.5))
                .frame(width: 7, height: 7)
            Text(title).font(.caption)
            Text(on ? "開" : "關")
                .font(.caption2).bold()
                .foregroundStyle(on ? .green : .secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(.background.secondary))
    }
}

// MARK: - Skills tab

private struct AgentSkillsTab: View {
    let agentId: String
    let mounted: [MountedSkill]
    let onChanged: () -> Void

    @State private var showMount = false
    @State private var busyId: String?
    @State private var errorText = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("已掛載技能").font(.headline)
                Spacer()
                Button {
                    showMount = true
                } label: {
                    Label("掛載技能", systemImage: "plus")
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 8)

            if !errorText.isEmpty {
                Text(errorText)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 20)
            }

            if mounted.isEmpty {
                ContentUnavailableView(
                    "尚未掛載技能",
                    systemImage: "wrench.and.screwdriver",
                    description: Text("點擊「掛載技能」從已確認的技能中選擇")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    ForEach(mounted) { item in
                        HStack(spacing: 10) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.skill.name).font(.body).bold()
                                HStack(spacing: 6) {
                                    CapsuleTag(text: item.skill.kind, color: .blue)
                                    ReviewCapsule(status: item.skill.reviewStatus)
                                }
                            }
                            Spacer()
                            Button(role: .destructive) {
                                Task { await unmount(item.skill.id) }
                            } label: {
                                if busyId == item.skill.id {
                                    ProgressView().controlSize(.small)
                                } else {
                                    Text("卸載")
                                }
                            }
                            .disabled(busyId != nil)
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
        }
        .sheet(isPresented: $showMount) {
            MountSkillSheet(agentId: agentId, alreadyMounted: Set(mounted.map(\.id))) {
                onChanged()
            }
        }
    }

    private func unmount(_ skillId: String) async {
        busyId = skillId
        errorText = ""
        struct Empty: Decodable {}
        do {
            let _: Empty = try await APIClient.shared.request(
                "/api/agents/\(agentId)/skills/\(skillId)",
                method: "DELETE"
            )
            onChanged()
        } catch let e as APIClient.APIError {
            errorText = e.message
        } catch {
            errorText = "卸載失敗"
        }
        busyId = nil
    }
}

private struct MountSkillSheet: View {
    @Environment(\.dismiss) private var dismiss
    let agentId: String
    let alreadyMounted: Set<String>
    let onMounted: () -> Void

    @State private var skills: [Skill] = []
    @State private var loading = false
    @State private var busyId: String?
    @State private var errorText = ""

    private var available: [Skill] {
        skills.filter { $0.reviewStatus == "CONFIRMED" && !alreadyMounted.contains($0.id) }
    }

    var body: some View {
        NavigationStack {
            Group {
                if loading && skills.isEmpty {
                    ProgressView("載入可掛載技能…")
                } else if available.isEmpty {
                    ContentUnavailableView(
                        "沒有可掛載的技能",
                        systemImage: "checkmark.seal",
                        description: Text("僅顯示狀態為「已確認」且尚未掛載的技能")
                    )
                } else {
                    List(available) { skill in
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(skill.name).bold()
                                Text(skill.kind).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("掛載") {
                                Task { await mount(skill.id) }
                            }
                            .disabled(busyId != nil)
                        }
                    }
                }
            }
            .navigationTitle("掛載技能")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("關閉") { dismiss() }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if !errorText.isEmpty {
                    Text(errorText).font(.caption).foregroundStyle(.red).padding(8)
                }
            }
            .task { await load() }
        }
        .frame(minWidth: 420, minHeight: 360)
    }

    private func load() async {
        loading = true
        do {
            skills = try await APIClient.shared.request("/api/skills")
            errorText = ""
        } catch let e as APIClient.APIError {
            errorText = e.message
        } catch {
            errorText = "載入技能失敗"
        }
        loading = false
    }

    private func mount(_ skillId: String) async {
        busyId = skillId
        errorText = ""
        struct Body: Encodable { let skillId: String }
        struct Empty: Decodable {}
        do {
            let _: Empty = try await APIClient.shared.request(
                "/api/agents/\(agentId)/skills",
                method: "POST",
                body: Body(skillId: skillId)
            )
            onMounted()
            dismiss()
        } catch let e as APIClient.APIError {
            errorText = e.message
        } catch {
            errorText = "掛載失敗"
        }
        busyId = nil
    }
}

// MARK: - Files tab

private struct AgentFilesTab: View {
    let targets: [FileTarget]

    var body: some View {
        Group {
            if targets.isEmpty {
                ContentUnavailableView(
                    "尚無雲端檔案",
                    systemImage: "doc.on.doc",
                    description: Text("檔案目標需在網頁版設定後於此檢視")
                )
            } else {
                List(targets) { target in
                    let ref = target.cloudFileRef
                    HStack(spacing: 12) {
                        Image(systemName: "doc.fill")
                            .foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(ref?.name ?? "未命名檔案")
                                .font(.body).bold()
                            HStack(spacing: 8) {
                                if let provider = ref?.provider {
                                    CapsuleTag(text: provider, color: .purple)
                                }
                                if let path = ref?.path, !path.isEmpty {
                                    Text(path)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                            }
                            if let purpose = target.purpose, !purpose.isEmpty {
                                Text(purpose).font(.caption).foregroundStyle(.tertiary)
                            }
                        }
                        Spacer()
                        if let urlStr = ref?.webUrl, let url = URL(string: urlStr) {
                            Link(destination: url) {
                                Label("開啟", systemImage: "arrow.up.right.square")
                            }
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }
}

// MARK: - Workflows tab

private struct AgentWorkflowsTab: View {
    let agentId: String

    @State private var workflows: [WorkflowSummary] = []
    @State private var loading = false
    @State private var errorText = ""
    @State private var actionMsg = ""
    @State private var busyId: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !errorText.isEmpty {
                Text(errorText).font(.caption).foregroundStyle(.red).padding(12)
            }
            if !actionMsg.isEmpty {
                Text(actionMsg)
                    .font(.caption)
                    .foregroundStyle(actionMsg.contains("失敗") ? .red : .secondary)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
            }

            if loading && workflows.isEmpty {
                ProgressView("載入工作流…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if workflows.isEmpty {
                ContentUnavailableView(
                    "尚無工作流",
                    systemImage: "arrow.triangle.branch",
                    description: Text("請在網頁版為此員工建立工作流")
                )
            } else {
                List(workflows) { wf in
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(wf.name).font(.body).bold()
                            HStack(spacing: 8) {
                                EnabledCapsule(enabled: wf.enabled)
                                if let type = wf.trigger?["type"]?.stringValue {
                                    CapsuleTag(text: triggerLabel(type), color: .blue)
                                }
                                if let count = wf.stepCount {
                                    Text("\(count) 步驟")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            if let desc = wf.description, !desc.isEmpty {
                                Text(desc).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                        Spacer()
                        Button {
                            Task { await run(wf.id) }
                        } label: {
                            if busyId == wf.id {
                                ProgressView().controlSize(.small)
                            } else {
                                Label("手動執行", systemImage: "play.fill")
                            }
                        }
                        .disabled(busyId != nil || !wf.enabled)
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .task(id: agentId) { await load() }
    }

    private func load() async {
        loading = true
        errorText = ""
        do {
            workflows = try await APIClient.shared.request("/api/agents/\(agentId)/workflows")
        } catch let e as APIClient.APIError {
            errorText = e.message
        } catch {
            errorText = "載入工作流失敗"
        }
        loading = false
    }

    private func run(_ id: String) async {
        busyId = id
        actionMsg = ""
        struct EmptyBody: Encodable {}
        do {
            let result: WorkflowRunResult = try await APIClient.shared.request(
                "/api/workflows/\(id)/run",
                method: "POST",
                body: EmptyBody()
            )
            actionMsg = "已手動執行，runId：\(result.runId)"
        } catch let e as APIClient.APIError {
            actionMsg = "執行失敗：\(e.message)"
        } catch {
            actionMsg = "執行失敗"
        }
        busyId = nil
    }

    private func triggerLabel(_ type: String) -> String {
        switch type.lowercased() {
        case "schedule": return "排程"
        case "keyword": return "關鍵字"
        case "manual": return "手動"
        case "webhook": return "Webhook"
        default: return type
        }
    }
}

// MARK: - Runs tab

private struct AgentRunsTab: View {
    let agentId: String

    @State private var runs: [RunSummary] = []
    @State private var selectedId: String?
    @State private var steps: [RunStepRow] = []
    @State private var loading = false
    @State private var loadingSteps = false
    @State private var errorText = ""

    var body: some View {
        HSplitView {
            VStack(alignment: .leading, spacing: 0) {
                if loading && runs.isEmpty {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if runs.isEmpty {
                    ContentUnavailableView("尚無執行紀錄", systemImage: "play.circle")
                } else {
                    List(runs, selection: $selectedId) { run in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                RunStatusCapsule(status: run.status)
                                Text(run.id.prefix(10) + "…")
                                    .font(.caption)
                                    .monospaced()
                                    .lineLimit(1)
                            }
                            Text("由 \(run.triggeredBy) · \(formatAgentDate(run.startedAt))")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        .tag(run.id)
                        .padding(.vertical, 2)
                    }
                }
            }
            .frame(minWidth: 220, idealWidth: 240, maxWidth: 300)

            VStack(alignment: .leading, spacing: 8) {
                if let selectedId {
                    Text("執行 \(selectedId)")
                        .font(.headline)
                        .textSelection(.enabled)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    if loadingSteps {
                        ProgressView()
                    } else if steps.isEmpty {
                        Text("尚無步驟").font(.caption).foregroundStyle(.secondary)
                    } else {
                        List(steps) { step in
                            HStack(alignment: .top, spacing: 6) {
                                Text("R\(step.round)")
                                    .font(.caption2).monospaced()
                                    .foregroundStyle(.secondary)
                                Text(step.stepKey)
                                    .font(.caption).bold()
                                    .lineLimit(2)
                                    .fixedSize(horizontal: false, vertical: true)
                                RunStatusCapsule(status: step.status)
                                if let approved = step.approved {
                                    Image(systemName: approved ? "checkmark.circle.fill" : "xmark.circle.fill")
                                        .foregroundStyle(approved ? .green : .red)
                                        .font(.caption2)
                                }
                                Spacer(minLength: 0)
                            }
                        }
                    }
                } else {
                    ContentUnavailableView("選擇一筆執行", systemImage: "list.bullet.rectangle")
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .safeAreaInset(edge: .bottom) {
            if !errorText.isEmpty {
                Text(errorText).font(.caption).foregroundStyle(.red).padding(6)
            }
        }
        .task(id: agentId) { await loadRuns() }
        .onChange(of: selectedId) { _, newValue in
            Task { await loadSteps(newValue) }
        }
    }

    private func loadRuns() async {
        loading = true
        errorText = ""
        do {
            runs = try await APIClient.shared.request(
                "/api/runs?agentId=\(agentId)&limit=50"
            )
            if selectedId == nil { selectedId = runs.first?.id }
        } catch let e as APIClient.APIError {
            errorText = e.message
        } catch {
            errorText = "載入執行紀錄失敗"
        }
        loading = false
    }

    private func loadSteps(_ id: String?) async {
        guard let id else { steps = []; return }
        loadingSteps = true
        do {
            let detail: AgentRunDetail = try await APIClient.shared.request("/api/runs/\(id)")
            steps = detail.steps
        } catch {
            steps = []
        }
        loadingSteps = false
    }
}

// MARK: - Train tab

private struct AgentTrainTab: View {
    let agentName: String

    @State private var requirement = ""
    @State private var engine = "CLAUDE_CODE"
    @State private var executionEnv = "CLI"
    @State private var busy = false
    @State private var message = ""
    @State private var isError = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("訓練新技能").font(.headline)
                Text("訓練並確認後，可到「技能」分頁掛載給「\(agentName)」。")
                    .font(.callout)
                    .foregroundStyle(.secondary)

                GroupBox {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("需求說明").font(.caption).foregroundStyle(.secondary)
                        TextEditor(text: $requirement)
                            .font(.body)
                            .frame(minHeight: 140)
                        Picker("訓練引擎", selection: $engine) {
                            ForEach(engineOptions, id: \.value) { opt in
                                Text(opt.label).tag(opt.value)
                            }
                        }
                        Picker("執行環境", selection: $executionEnv) {
                            Text("CLI").tag("CLI")
                            Text("桌面 App").tag("DESKTOP_APP")
                            Text("Direct").tag("DIRECT")
                        }
                        HStack {
                            Button {
                                Task { await submit() }
                            } label: {
                                if busy { ProgressView().controlSize(.small) }
                                else { Label("開始訓練", systemImage: "wand.and.stars") }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(busy || requirement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            Spacer()
                        }
                        if !message.isEmpty {
                            Text(message)
                                .font(.caption)
                                .foregroundStyle(isError ? .red : .secondary)
                                .textSelection(.enabled)
                        }
                    }
                    .padding(6)
                }
            }
            .padding(20)
        }
    }

    private func submit() async {
        busy = true
        message = ""
        isError = false
        struct Body: Encodable {
            let requirement: String
            let engine: String
            let executionEnv: String
        }
        do {
            let skill: Skill = try await APIClient.shared.request(
                "/api/skills/build",
                method: "POST",
                body: Body(
                    requirement: requirement.trimmingCharacters(in: .whitespacesAndNewlines),
                    engine: engine,
                    executionEnv: executionEnv
                )
            )
            message = "已送出訓練，技能「\(skill.name)」狀態：\(skill.reviewStatus)。請至全域「技能」頁確認後，再回「技能」分頁掛載。"
            requirement = ""
        } catch let e as APIClient.APIError {
            message = e.message
            isError = true
        } catch {
            message = "訓練請求失敗"
            isError = true
        }
        busy = false
    }
}

// MARK: - Chat pane (preserved logic)

/// Original conversation + live run timeline, extracted as its own tab pane.
private struct AgentChatPane: View {
    @Environment(AppState.self) private var app
    let agentId: String
    let agentName: String

    @State private var conversations: [ConversationRow] = []
    @State private var selectedConversationID: String?
    @State private var messages: [MessageRow] = []
    @State private var loadingMessages = false

    @State private var composerText = ""
    @State private var sending = false

    @State private var activeRunId: String?
    @State private var runSteps: [RunStepRow] = []
    @State private var runStatus: String?
    @State private var pollTask: Task<Void, Never>?

    @State private var errorText = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("對話").font(.headline)
                    Spacer()
                    conversationPicker
                    Button {
                        Task { await createConversation() }
                    } label: {
                        Image(systemName: "plus.bubble")
                    }
                    .help("新增對話")
                }

                if !errorText.isEmpty {
                    Text(errorText).font(.caption).foregroundStyle(.red)
                }

                messageList

                if activeRunId != nil {
                    RunTimelineView(steps: runSteps, status: runStatus)
                }

                composer
            }
            .padding(20)
        }
        .task(id: agentId) {
            resetForNewAgent()
            await loadConversations()
        }
        .onDisappear { pollTask?.cancel() }
        .onChange(of: app.activity.first?.id) { _, _ in
            guard activeRunId != nil else { return }
            Task { await refreshRunIfNeeded() }
        }
    }

    private var conversationPicker: some View {
        Picker("", selection: $selectedConversationID) {
            if conversations.isEmpty {
                Text("尚無對話").tag(String?.none)
            }
            ForEach(conversations) { conv in
                Text(conv.title?.isEmpty == false ? conv.title! : "對話 \(conv.id.prefix(6))")
                    .tag(Optional(conv.id))
            }
        }
        .labelsHidden()
        .frame(maxWidth: 220)
        .onChange(of: selectedConversationID) { _, newValue in
            pollTask?.cancel()
            activeRunId = nil
            runSteps = []
            runStatus = nil
            guard let cid = newValue else { messages = []; return }
            Task { await loadMessages(cid) }
        }
    }

    private var messageList: some View {
        Group {
            if loadingMessages && messages.isEmpty {
                ProgressView().frame(maxWidth: .infinity, minHeight: 120)
            } else if messages.isEmpty {
                Text("尚無訊息，開始對話吧。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 80)
            } else {
                // Own ScrollView so long threads scroll inside the 340pt box
                // (outer page ScrollView alone would clip without independent scroll).
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(messages) { msg in
                            MessageBubble(message: msg)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(minHeight: 160, maxHeight: 340)
        .background(.quaternary.opacity(0.15), in: RoundedRectangle(cornerRadius: 8))
        .padding(.vertical, 4)
    }

    private var composer: some View {
        HStack {
            TextField("輸入訊息…", text: $composerText, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
                .onSubmit { send() }
            Button("送出") { send() }
                .buttonStyle(.borderedProminent)
                .disabled(
                    sending
                        || composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || selectedConversationID == nil
                )
        }
    }

    private func resetForNewAgent() {
        pollTask?.cancel()
        pollTask = nil
        conversations = []
        selectedConversationID = nil
        messages = []
        composerText = ""
        activeRunId = nil
        runSteps = []
        runStatus = nil
        errorText = ""
    }

    private func loadConversations() async {
        do {
            let list: [ConversationRow] = try await APIClient.shared.request(
                "/api/agents/\(agentId)/conversations"
            )
            conversations = list
            if selectedConversationID == nil {
                selectedConversationID = list.first?.id
            }
            if let cid = selectedConversationID {
                await loadMessages(cid)
            }
        } catch let e as APIClient.APIError {
            errorText = e.message
        } catch {
            errorText = "載入對話失敗"
        }
    }

    private func createConversation() async {
        struct Body: Encodable { let title: String? }
        do {
            let conv: ConversationRow = try await APIClient.shared.request(
                "/api/agents/\(agentId)/conversations",
                method: "POST",
                body: Body(title: nil)
            )
            conversations.insert(conv, at: 0)
            selectedConversationID = conv.id
            messages = []
            errorText = ""
        } catch let e as APIClient.APIError {
            errorText = e.message
        } catch {
            errorText = "建立對話失敗"
        }
    }

    private func loadMessages(_ conversationId: String) async {
        loadingMessages = true
        do {
            messages = try await APIClient.shared.request(
                "/api/conversations/\(conversationId)/messages"
            )
            errorText = ""
        } catch let e as APIClient.APIError {
            errorText = e.message
        } catch {
            errorText = "載入訊息失敗"
        }
        loadingMessages = false
    }

    private func send() {
        guard let cid = selectedConversationID else { return }
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        composerText = ""

        let optimistic = MessageRow(
            id: "local-\(UUID().uuidString)",
            role: "user",
            content: text,
            runId: nil,
            createdAt: ISO8601DateFormatter().string(from: Date())
        )
        messages.append(optimistic)
        sending = true
        errorText = ""

        Task {
            struct Body: Encodable { let content: String }
            do {
                let result: SendMessageResult = try await APIClient.shared.request(
                    "/api/conversations/\(cid)/messages",
                    method: "POST",
                    body: Body(content: text)
                )
                activeRunId = result.runId
                runSteps = []
                runStatus = "running"
                pollTask?.cancel()
                pollTask = Task { await pollRun(runId: result.runId, conversationId: cid) }
            } catch let e as APIClient.APIError {
                errorText = e.message
            } catch {
                errorText = "傳送失敗"
            }
            sending = false
        }
    }

    private func pollRun(runId: String, conversationId: String) async {
        while !Task.isCancelled {
            do {
                let detail: AgentRunDetail = try await APIClient.shared.request("/api/runs/\(runId)")
                runSteps = detail.steps
                runStatus = detail.status
                if terminalRunStatuses.contains(detail.status.lowercased()) {
                    await loadMessages(conversationId)
                    activeRunId = nil
                    return
                }
            } catch {
                // keep polling
            }
            try? await Task.sleep(nanoseconds: 1_500_000_000)
        }
    }

    private func refreshRunIfNeeded() async {
        guard let runId = activeRunId, let cid = selectedConversationID else { return }
        do {
            let detail: AgentRunDetail = try await APIClient.shared.request("/api/runs/\(runId)")
            runSteps = detail.steps
            runStatus = detail.status
            if terminalRunStatuses.contains(detail.status.lowercased()) {
                pollTask?.cancel()
                await loadMessages(cid)
                activeRunId = nil
            }
        } catch {
            // poll loop will retry
        }
    }
}

// MARK: - Message bubble

private struct MessageBubble: View {
    let message: MessageRow

    private var isUser: Bool { message.role.lowercased() == "user" }

    var body: some View {
        HStack {
            if isUser { Spacer(minLength: 40) }
            VStack(alignment: .leading, spacing: 2) {
                Text(roleLabel).font(.caption2).foregroundStyle(.secondary)
                Text(message.content)
                    .padding(8)
                    .background(
                        isUser ? Color.accentColor.opacity(0.18) : Color.gray.opacity(0.15),
                        in: RoundedRectangle(cornerRadius: 8)
                    )
            }
            if !isUser { Spacer(minLength: 40) }
        }
    }

    private var roleLabel: String {
        switch message.role.lowercased() {
        case "user": return "我"
        case "assistant", "agent": return "員工"
        case "system": return "系統"
        default: return message.role
        }
    }
}

// MARK: - Live run step timeline

private struct RunTimelineView: View {
    let steps: [RunStepRow]
    let status: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                ProgressView().controlSize(.small).opacity(isRunning ? 1 : 0)
                Text("執行中" + (status.map { "（\($0)）" } ?? "")).font(.caption).bold()
                Spacer()
            }
            if steps.isEmpty {
                Text("等待步驟…").font(.caption2).foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(steps) { step in
                        ChatStepRowView(step: step)
                    }
                }
            }
        }
        .padding(8)
        .background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.orange.opacity(0.25)))
    }

    private var isRunning: Bool {
        guard let status else { return true }
        return !terminalRunStatuses.contains(status.lowercased())
    }
}

private struct ChatStepRowView: View {
    let step: RunStepRow

    var body: some View {
        HStack(spacing: 6) {
            Text("R\(step.round)").font(.caption2).monospaced().foregroundStyle(.secondary)
            Text(step.stepKey).font(.caption).bold()
            Text(step.status).font(.caption2).foregroundStyle(.secondary)
            if let verdict = step.verdict {
                Text(verdict).font(.caption2)
                    .padding(.horizontal, 4)
                    .background(.blue.opacity(0.15), in: Capsule())
            }
            if let approved = step.approved {
                Image(systemName: approved ? "checkmark.circle.fill" : "xmark.circle.fill")
                    .foregroundStyle(approved ? .green : .red)
                    .font(.caption2)
            }
            Spacer()
        }
    }
}

// MARK: - Create agent sheet

private struct CreateAgentSheet: View {
    @Environment(\.dismiss) private var dismiss
    var onCreated: (Agent) -> Void

    @State private var name = ""
    @State private var description = ""
    @State private var department = "未分類"
    @State private var rolePrompt = ""
    @State private var engine = "CLAUDE_CODE"
    /// "" = 自動（不送 engineVerify）
    @State private var verifyEngine = ""
    @State private var maxRounds = 5
    @State private var restrictions = Restrictions.defaults
    @State private var notes = ""
    @State private var busy = false
    @State private var errorText = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("基本資訊") {
                    TextField("名稱", text: $name)
                    TextField("描述", text: $description)
                    TextField("部門", text: $department)
                }
                Section("角色設定") {
                    TextField("角色提示詞", text: $rolePrompt, axis: .vertical)
                        .lineLimit(3...8)
                    Picker("執行引擎", selection: $engine) {
                        ForEach(engineOptions, id: \.value) { opt in
                            Text(opt.label).tag(opt.value)
                        }
                    }
                    Picker("驗證引擎", selection: $verifyEngine) {
                        Text("自動").tag("")
                        ForEach(engineOptions, id: \.value) { opt in
                            Text(opt.label).tag(opt.value)
                        }
                    }
                    Stepper("最大回合數：\(maxRounds)", value: $maxRounds, in: 1...20)
                }
                Section("能力限制") {
                    Toggle("網路搜尋", isOn: $restrictions.webSearch)
                    Toggle("電腦操控", isOn: $restrictions.computerUse)
                    Toggle("寄信", isOn: $restrictions.sendEmail)
                    Toggle("雲端寫入", isOn: $restrictions.cloudWrite)
                    Toggle("Shell", isOn: $restrictions.shell)
                    TextField("限制備註", text: $notes, axis: .vertical)
                        .lineLimit(1...3)
                }
                if !errorText.isEmpty {
                    Section {
                        Text(errorText).font(.caption).foregroundStyle(.red)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("新增員工")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("建立") { submit() }
                        .disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || rolePrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .frame(minWidth: 460, minHeight: 520)
    }

    private func submit() {
        busy = true
        errorText = ""
        var r = restrictions
        let trimmedNotes = notes.trimmingCharacters(in: .whitespacesAndNewlines)
        r.notes = trimmedNotes.isEmpty ? nil : trimmedNotes

        Task {
            do {
                let agent: Agent
                if verifyEngine.isEmpty {
                    struct Body: Encodable {
                        let name: String
                        let description: String
                        let department: String?
                        let rolePrompt: String
                        let engineExecute: String
                        let restrictions: Restrictions
                        let maxRounds: Int
                    }
                    agent = try await APIClient.shared.request(
                        "/api/agents",
                        method: "POST",
                        body: Body(
                            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                            description: description.trimmingCharacters(in: .whitespacesAndNewlines),
                            department: department.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                ? nil : department.trimmingCharacters(in: .whitespacesAndNewlines),
                            rolePrompt: rolePrompt,
                            engineExecute: engine,
                            restrictions: r,
                            maxRounds: maxRounds
                        )
                    )
                } else {
                    struct Body: Encodable {
                        let name: String
                        let description: String
                        let department: String?
                        let rolePrompt: String
                        let engineExecute: String
                        let engineVerify: String
                        let restrictions: Restrictions
                        let maxRounds: Int
                    }
                    agent = try await APIClient.shared.request(
                        "/api/agents",
                        method: "POST",
                        body: Body(
                            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                            description: description.trimmingCharacters(in: .whitespacesAndNewlines),
                            department: department.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                ? nil : department.trimmingCharacters(in: .whitespacesAndNewlines),
                            rolePrompt: rolePrompt,
                            engineExecute: engine,
                            engineVerify: verifyEngine,
                            restrictions: r,
                            maxRounds: maxRounds
                        )
                    )
                }
                onCreated(agent)
                dismiss()
            } catch let e as APIClient.APIError {
                errorText = e.message
            } catch {
                errorText = "建立失敗"
            }
            busy = false
        }
    }
}

// MARK: - Edit agent sheet

private struct EditAgentSheet: View {
    @Environment(\.dismiss) private var dismiss
    let detail: AgentDetail
    let onSaved: () -> Void

    @State private var name: String
    @State private var description: String
    @State private var department: String
    @State private var rolePrompt: String
    @State private var engine: String
    /// "" = 自動 → PATCH 送 null
    @State private var verifyEngine: String
    @State private var maxRounds: Int
    @State private var restrictions: Restrictions
    @State private var notes: String
    @State private var busy = false
    @State private var errorText = ""

    init(detail: AgentDetail, onSaved: @escaping () -> Void) {
        self.detail = detail
        self.onSaved = onSaved
        _name = State(initialValue: detail.name)
        _description = State(initialValue: detail.description)
        _department = State(initialValue: detail.department ?? "未分類")
        _rolePrompt = State(initialValue: detail.rolePrompt ?? "")
        _engine = State(initialValue: detail.engineExecute ?? "CLAUDE_CODE")
        _verifyEngine = State(initialValue: detail.engineVerify ?? "")
        _maxRounds = State(initialValue: detail.maxRounds ?? 5)
        let r = detail.restrictions ?? .defaults
        _restrictions = State(initialValue: r)
        _notes = State(initialValue: r.notes ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("基本資訊") {
                    TextField("名稱", text: $name)
                    TextField("描述", text: $description)
                    TextField("部門", text: $department)
                }
                Section("角色設定") {
                    TextField("角色提示詞", text: $rolePrompt, axis: .vertical)
                        .lineLimit(3...10)
                    Picker("執行引擎", selection: $engine) {
                        ForEach(engineOptions, id: \.value) { opt in
                            Text(opt.label).tag(opt.value)
                        }
                    }
                    Picker("驗證引擎", selection: $verifyEngine) {
                        Text("自動").tag("")
                        ForEach(engineOptions, id: \.value) { opt in
                            Text(opt.label).tag(opt.value)
                        }
                    }
                    Stepper("最大回合數：\(maxRounds)", value: $maxRounds, in: 1...20)
                }
                Section("能力限制") {
                    Toggle("網路搜尋", isOn: $restrictions.webSearch)
                    Toggle("電腦操控", isOn: $restrictions.computerUse)
                    Toggle("寄信", isOn: $restrictions.sendEmail)
                    Toggle("雲端寫入", isOn: $restrictions.cloudWrite)
                    Toggle("Shell", isOn: $restrictions.shell)
                    TextField("限制備註", text: $notes, axis: .vertical)
                        .lineLimit(1...3)
                }
                if !errorText.isEmpty {
                    Section {
                        Text(errorText).font(.caption).foregroundStyle(.red)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("編輯員工")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("儲存") { submit() }
                        .disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || rolePrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .frame(minWidth: 460, minHeight: 520)
    }

    private func submit() {
        busy = true
        errorText = ""
        var r = restrictions
        let trimmedNotes = notes.trimmingCharacters(in: .whitespacesAndNewlines)
        r.notes = trimmedNotes.isEmpty ? nil : trimmedNotes

        let body = AgentPatchBody(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            description: description.trimmingCharacters(in: .whitespacesAndNewlines),
            department: department.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "未分類" : department.trimmingCharacters(in: .whitespacesAndNewlines),
            rolePrompt: rolePrompt,
            engineExecute: engine,
            engineVerify: verifyEngine.isEmpty ? nil : verifyEngine,
            sendVerifyNull: verifyEngine.isEmpty,
            restrictions: r,
            maxRounds: maxRounds
        )

        Task {
            do {
                let _: Agent = try await APIClient.shared.request(
                    "/api/agents/\(detail.id)",
                    method: "PATCH",
                    body: body
                )
                onSaved()
                dismiss()
            } catch let e as APIClient.APIError {
                errorText = e.message
            } catch {
                errorText = "儲存失敗"
            }
            busy = false
        }
    }
}

/// PATCH body that can encode engineVerify as JSON null when auto is selected.
private struct AgentPatchBody: Encodable {
    let name: String
    let description: String
    let department: String
    let rolePrompt: String
    let engineExecute: String
    let engineVerify: String?
    let sendVerifyNull: Bool
    let restrictions: Restrictions
    let maxRounds: Int

    enum CodingKeys: String, CodingKey {
        case name, description, department, rolePrompt
        case engineExecute, engineVerify, restrictions, maxRounds
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encode(description, forKey: .description)
        try c.encode(department, forKey: .department)
        try c.encode(rolePrompt, forKey: .rolePrompt)
        try c.encode(engineExecute, forKey: .engineExecute)
        if sendVerifyNull {
            try c.encodeNil(forKey: .engineVerify)
        } else if let engineVerify {
            try c.encode(engineVerify, forKey: .engineVerify)
        }
        try c.encode(restrictions, forKey: .restrictions)
        try c.encode(maxRounds, forKey: .maxRounds)
    }
}

// MARK: - Small shared UI bits

private struct CapsuleTag: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.caption2)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(color.opacity(0.12), in: Capsule())
            .foregroundStyle(color)
    }
}

private struct ReviewCapsule: View {
    let status: String

    private var label: String {
        switch status {
        case "PENDING_UNDERSTANDING": return "分析中"
        case "AWAITING_USER_CONFIRM": return "待確認"
        case "CONFIRMED": return "已確認"
        case "REJECTED": return "已拒絕"
        default: return status
        }
    }

    private var color: Color {
        switch status {
        case "CONFIRMED": return .green
        case "AWAITING_USER_CONFIRM": return .blue
        case "PENDING_UNDERSTANDING": return .orange
        case "REJECTED": return .red
        default: return .secondary
        }
    }

    var body: some View {
        Text(label)
            .font(.caption2).bold()
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }
}

private struct EnabledCapsule: View {
    let enabled: Bool

    var body: some View {
        Text(enabled ? "啟用" : "停用")
            .font(.caption2).bold()
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background((enabled ? Color.green : Color.secondary).opacity(0.15), in: Capsule())
            .foregroundStyle(enabled ? .green : .secondary)
    }
}

private struct RunStatusCapsule: View {
    let status: String

    private var color: Color {
        switch status.uppercased() {
        case "RUNNING", "IN_PROGRESS": return .blue
        case "SUCCEEDED", "SUCCESS", "COMPLETED", "APPROVED": return .green
        case "FAILED", "ERROR", "REJECTED": return .red
        case "CANCELLED", "CANCELED": return .secondary
        case "PENDING", "QUEUED", "WAITING": return .orange
        default: return .gray
        }
    }

    var body: some View {
        Text(status)
            .font(.caption2).bold()
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(color.opacity(0.18), in: Capsule())
            .foregroundStyle(color)
    }
}

private func formatAgentDate(_ iso: String) -> String {
    let isoFormatter = ISO8601DateFormatter()
    isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    var date = isoFormatter.date(from: iso)
    if date == nil {
        isoFormatter.formatOptions = [.withInternetDateTime]
        date = isoFormatter.date(from: iso)
    }
    guard let date else { return iso }
    let formatter = DateFormatter()
    formatter.dateFormat = "MM/dd HH:mm:ss"
    formatter.locale = Locale(identifier: "zh_Hant_TW")
    return formatter.string(from: date)
}
