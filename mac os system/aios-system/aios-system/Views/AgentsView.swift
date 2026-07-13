//
//  AgentsView.swift
//  aios-system
//
//  員工 (Agents) — master/detail. Left: agent list. Right: overview + chat
//  with a live run step timeline (the headline realtime demo).
//

import SwiftUI

// MARK: - Local wire types not covered by Core/Models.swift

/// Shape returned by GET /api/runs/:id — the run itself plus its steps.
private struct AgentRunDetail: Decodable {
    let run: RunSummary
    let steps: [RunStepRow]
}

private struct SendMessageResult: Decodable {
    let messageId: String
    let runId: String
}

private let terminalRunStatuses: Set<String> = ["completed", "success", "failed", "error", "cancelled", "canceled"]

// MARK: - AgentsView

struct AgentsView: View {
    @Environment(AppState.self) private var app

    @State private var agents: [Agent] = []
    @State private var selectedAgentID: String?
    @State private var loading = false
    @State private var errorText = ""
    @State private var showCreate = false

    var body: some View {
        NavigationSplitView {
            Group {
                if loading && agents.isEmpty {
                    ProgressView("載入員工…").frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if agents.isEmpty {
                    ContentUnavailableView("尚無員工", systemImage: "person.2", description: Text("點擊右上角「＋」建立第一位員工"))
                } else {
                    List(agents, selection: $selectedAgentID) { agent in
                        AgentRow(agent: agent).tag(agent.id)
                    }
                }
            }
            .navigationTitle("員工")
            .toolbar {
                ToolbarItem {
                    Button { showCreate = true } label: { Label("新增員工", systemImage: "plus") }
                }
            }
            .task { await loadAgents() }
            .refreshable { await loadAgents() }
            .safeAreaInset(edge: .bottom) {
                if !errorText.isEmpty {
                    Text(errorText).font(.caption).foregroundStyle(.red).padding(6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        } detail: {
            if let id = selectedAgentID, let agent = agents.first(where: { $0.id == id }) {
                AgentDetailView(agent: agent)
            } else {
                ContentUnavailableView("選擇一位員工", systemImage: "person.crop.circle", description: Text("從左側清單選擇以查看詳情與對話"))
            }
        }
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
            StatusBadge(status: agent.status)
        }
        .padding(.vertical, 2)
    }
}

private struct StatusBadge: View {
    let status: String

    private var color: Color {
        switch status.lowercased() {
        case "active", "running", "online": return .green
        case "paused", "idle": return .orange
        case "error", "failed": return .red
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

// MARK: - AgentDetailView

struct AgentDetailView: View {
    @Environment(AppState.self) private var app
    let agent: Agent

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
            VStack(alignment: .leading, spacing: 20) {
                overviewSection
                Divider()
                chatSection
            }
            .padding()
        }
        .navigationTitle(agent.name)
        .task(id: agent.id) {
            resetForNewAgent()
            await loadConversations()
        }
        .onDisappear { pollTask?.cancel() }
        .onChange(of: app.activity.first?.id) { _, _ in
            guard activeRunId != nil else { return }
            Task { await refreshRunIfNeeded() }
        }
    }

    // MARK: Overview

    private var overviewSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("概況").font(.headline)
            GroupBox {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("名稱").foregroundStyle(.secondary)
                        Spacer()
                        Text(agent.name)
                    }
                    HStack {
                        Text("狀態").foregroundStyle(.secondary)
                        Spacer()
                        StatusBadge(status: agent.status)
                    }
                    if let skillCount = agent.skillCount {
                        HStack {
                            Text("技能數").foregroundStyle(.secondary)
                            Spacer()
                            Text("\(skillCount)")
                        }
                    }
                    if let workflowCount = agent.workflowCount {
                        HStack {
                            Text("工作流數").foregroundStyle(.secondary)
                            Spacer()
                            Text("\(workflowCount)")
                        }
                    }
                    Divider()
                    Text(agent.description).font(.callout).foregroundStyle(.secondary)
                }
                .padding(6)
            }
        }
    }

    // MARK: Chat

    private var chatSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("對話").font(.headline)
                Spacer()
                conversationPicker
                Button {
                    Task { await createConversation() }
                } label: { Image(systemName: "plus.bubble") }
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
            pollTask?.cancel(); activeRunId = nil; runSteps = []; runStatus = nil
            guard let cid = newValue else { messages = []; return }
            Task { await loadMessages(cid) }
        }
    }

    private var messageList: some View {
        Group {
            if loadingMessages && messages.isEmpty {
                ProgressView().frame(maxWidth: .infinity, minHeight: 120)
            } else if messages.isEmpty {
                Text("尚無訊息，開始對話吧。").font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 80)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(messages) { msg in
                        MessageBubble(message: msg)
                    }
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
                .disabled(sending || composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || selectedConversationID == nil)
        }
    }

    // MARK: Actions

    private func resetForNewAgent() {
        pollTask?.cancel(); pollTask = nil
        conversations = []; selectedConversationID = nil
        messages = []; composerText = ""
        activeRunId = nil; runSteps = []; runStatus = nil
        errorText = ""
    }

    private func loadConversations() async {
        do {
            let list: [ConversationRow] = try await APIClient.shared.request("/api/agents/\(agent.id)/conversations")
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
                "/api/agents/\(agent.id)/conversations", method: "POST", body: Body(title: nil)
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
            messages = try await APIClient.shared.request("/api/conversations/\(conversationId)/messages")
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
            id: "local-\(UUID().uuidString)", role: "user", content: text,
            runId: nil, createdAt: ISO8601DateFormatter().string(from: Date())
        )
        messages.append(optimistic)
        sending = true
        errorText = ""

        Task {
            struct Body: Encodable { let content: String }
            do {
                let result: SendMessageResult = try await APIClient.shared.request(
                    "/api/conversations/\(cid)/messages", method: "POST", body: Body(content: text)
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

    /// Polls the run every ~1.5s until it reaches a terminal state, then
    /// refreshes messages to reveal the agent's reply. `app.activity`
    /// (populated from AWP run.* events) can trigger an earlier refresh via
    /// `refreshRunIfNeeded`, but this loop is the reliable fallback.
    private func pollRun(runId: String, conversationId: String) async {
        while !Task.isCancelled {
            do {
                let detail: AgentRunDetail = try await APIClient.shared.request("/api/runs/\(runId)")
                runSteps = detail.steps
                runStatus = detail.run.status
                if terminalRunStatuses.contains(detail.run.status.lowercased()) {
                    await loadMessages(conversationId)
                    activeRunId = nil
                    return
                }
            } catch {
                // keep polling; transient errors shouldn't kill the timeline
            }
            try? await Task.sleep(nanoseconds: 1_500_000_000)
        }
    }

    /// Called when a new AWP activity item arrives while a run is active —
    /// gives the timeline a snappier update than waiting for the next poll tick.
    private func refreshRunIfNeeded() async {
        guard let runId = activeRunId, let cid = selectedConversationID else { return }
        do {
            let detail: AgentRunDetail = try await APIClient.shared.request("/api/runs/\(runId)")
            runSteps = detail.steps
            runStatus = detail.run.status
            if terminalRunStatuses.contains(detail.run.status.lowercased()) {
                pollTask?.cancel()
                await loadMessages(cid)
                activeRunId = nil
            }
        } catch {
            // ignore; the poll loop will retry
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
                    .background(isUser ? Color.accentColor.opacity(0.18) : Color.gray.opacity(0.15), in: RoundedRectangle(cornerRadius: 8))
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
                        StepRowView(step: step)
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

private struct StepRowView: View {
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
    @State private var rolePrompt = ""
    @State private var engine = "claude"
    @State private var maxRounds = 5
    @State private var busy = false
    @State private var errorText = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("基本資訊") {
                    TextField("名稱", text: $name)
                    TextField("描述", text: $description)
                }
                Section("角色設定") {
                    TextField("角色提示詞", text: $rolePrompt, axis: .vertical)
                        .lineLimit(3...8)
                    Picker("執行引擎", selection: $engine) {
                        Text("Claude").tag("claude")
                        Text("Codex").tag("codex")
                    }
                    Stepper("最大回合數：\(maxRounds)", value: $maxRounds, in: 1...20)
                }
                if !errorText.isEmpty {
                    Text(errorText).font(.caption).foregroundStyle(.red)
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
                        .disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .frame(minWidth: 420, minHeight: 360)
    }

    private func submit() {
        busy = true
        errorText = ""
        struct Body: Encodable {
            let name: String
            let description: String
            let rolePrompt: String
            let engineExecute: String
            let maxRounds: Int
        }
        Task {
            do {
                let agent: Agent = try await APIClient.shared.request(
                    "/api/agents", method: "POST",
                    body: Body(name: name, description: description, rolePrompt: rolePrompt, engineExecute: engine, maxRounds: maxRounds)
                )
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
