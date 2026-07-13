//
//  WorkflowsView.swift
//  aios-system
//
//  跨員工彙總工作流列表、詳情、手動執行與測試。
//

import SwiftUI

struct WorkflowsView: View {
    @Environment(AppState.self) private var app

    @State private var items: [WorkflowListItem] = []
    @State private var selectedId: String?
    @State private var detail: WorkflowDetail?
    @State private var loading = false
    @State private var loadingDetail = false
    @State private var errorText = ""
    @State private var actionMessage = ""
    @State private var actionBusy = false

    private var selectedItem: WorkflowListItem? {
        items.first(where: { $0.id == selectedId })
    }

    var body: some View {
        HSplitView {
            // 左：工作流清單
            VStack(spacing: 0) {
                Group {
                    if loading && items.isEmpty {
                        ProgressView("載入工作流…").frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else if items.isEmpty {
                        ContentUnavailableView(
                            "尚無工作流",
                            systemImage: "arrow.triangle.branch",
                            description: Text("請先在員工下建立工作流")
                        )
                    } else {
                        List(items, selection: $selectedId) { item in
                            WorkflowRow(item: item).tag(item.id)
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
                if loadingDetail && detail == nil {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let detail {
                    WorkflowDetailPane(
                        summary: selectedItem,
                        detail: detail,
                        actionBusy: actionBusy,
                        actionMessage: actionMessage,
                        onRun: { Task { await run(detail.id) } },
                        onTest: { Task { await test(detail.id) } }
                    )
                } else {
                    ContentUnavailableView(
                        "選擇一個工作流",
                        systemImage: "arrow.triangle.branch",
                        description: Text("從左側清單選擇以查看觸發條件與步驟")
                    )
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .navigationTitle("工作流")
        .toolbar {
            ToolbarItem {
                Button { Task { await loadAll() } } label: {
                    Label("重新整理", systemImage: "arrow.clockwise")
                }
                .disabled(loading)
            }
        }
        .task { await loadAll() }
        .onChange(of: selectedId) { _, newValue in
            actionMessage = ""
            Task { await loadDetail(id: newValue) }
        }
    }

    /// Aggregate workflows across all agents via GET /api/agents/:id/workflows.
    /// Per-agent fetches run concurrently; a single agent failure is skipped.
    private func loadAll() async {
        loading = true
        errorText = ""
        do {
            let agents: [Agent] = try await APIClient.shared.request("/api/agents")
            let collected: [WorkflowListItem] = await withTaskGroup(of: [WorkflowListItem].self) { group in
                for agent in agents {
                    group.addTask {
                        let list: [WorkflowSummary]? = try? await APIClient.shared.request(
                            "/api/agents/\(agent.id)/workflows"
                        )
                        guard let list else { return [] }
                        return list.map { WorkflowListItem(workflow: $0, agentName: agent.name) }
                    }
                }
                var all: [WorkflowListItem] = []
                for await batch in group {
                    all.append(contentsOf: batch)
                }
                return all
            }
            items = collected.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            if selectedId == nil { selectedId = items.first?.id }
            if let id = selectedId, !items.contains(where: { $0.id == id }) {
                selectedId = items.first?.id
            }
            if let id = selectedId {
                await loadDetail(id: id)
            }
        } catch let e as APIClient.APIError {
            errorText = e.message
        } catch {
            errorText = "載入工作流失敗"
        }
        loading = false
    }

    private func loadDetail(id: String?) async {
        guard let id else { detail = nil; return }
        loadingDetail = true
        do {
            detail = try await APIClient.shared.request("/api/workflows/\(id)")
        } catch let e as APIClient.APIError {
            errorText = e.message
            detail = nil
        } catch {
            errorText = "載入工作流詳情失敗"
            detail = nil
        }
        loadingDetail = false
    }

    private func run(_ id: String) async {
        actionBusy = true
        actionMessage = ""
        struct EmptyBody: Encodable {}
        do {
            let result: WorkflowRunResult = try await APIClient.shared.request(
                "/api/workflows/\(id)/run",
                method: "POST",
                body: EmptyBody()
            )
            actionMessage = "已手動執行，runId：\(result.runId)"
        } catch let e as APIClient.APIError {
            actionMessage = "執行失敗：\(e.message)"
        } catch {
            actionMessage = "執行失敗"
        }
        actionBusy = false
    }

    private func test(_ id: String) async {
        actionBusy = true
        actionMessage = ""
        struct EmptyBody: Encodable {}
        do {
            let result: WorkflowRunResult = try await APIClient.shared.request(
                "/api/workflows/\(id)/test",
                method: "POST",
                body: EmptyBody()
            )
            actionMessage = "已啟動測試，runId：\(result.runId)"
        } catch let e as APIClient.APIError {
            actionMessage = "測試失敗：\(e.message)"
        } catch {
            actionMessage = "測試失敗"
        }
        actionBusy = false
    }
}

// MARK: - List item

private struct WorkflowListItem: Identifiable {
    let id: String
    let agentId: String?
    let agentName: String
    let name: String
    let description: String?
    let enabled: Bool
    let trigger: JSONValue?
    let stepCount: Int?

    init(workflow: WorkflowSummary, agentName: String) {
        self.id = workflow.id
        self.agentId = workflow.agentId
        self.agentName = agentName
        self.name = workflow.name
        self.description = workflow.description
        self.enabled = workflow.enabled
        self.trigger = workflow.trigger
        self.stepCount = workflow.stepCount
    }

    var triggerType: String {
        trigger?["type"]?.stringValue ?? "—"
    }
}

// MARK: - Row

private struct WorkflowRow: View {
    let item: WorkflowListItem

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(item.name).font(.body).bold().lineLimit(1)
                Spacer(minLength: 8)
                EnabledBadge(enabled: item.enabled)
            }
            HStack(spacing: 6) {
                Text(item.agentName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                TriggerTypeBadge(type: item.triggerType)
                if let count = item.stepCount {
                    Text("\(count) 步驟").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 3)
    }
}

// MARK: - Detail

private struct WorkflowDetailPane: View {
    let summary: WorkflowListItem?
    let detail: WorkflowDetail
    let actionBusy: Bool
    let actionMessage: String
    let onRun: () -> Void
    let onTest: () -> Void

    private var triggerType: String {
        detail.trigger?["type"]?.stringValue
            ?? summary?.triggerType
            ?? "—"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(detail.name)
                            .font(.title2).bold()
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 8)
                        EnabledBadge(enabled: detail.enabled)
                        TriggerTypeBadge(type: triggerType)
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Text(detail.name)
                            .font(.title2).bold()
                            .fixedSize(horizontal: false, vertical: true)
                        HStack(spacing: 8) {
                            EnabledBadge(enabled: detail.enabled)
                            TriggerTypeBadge(type: triggerType)
                        }
                    }
                }

                if let agentName = summary?.agentName {
                    Text("所屬員工：\(agentName)")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let desc = detail.description, !desc.isEmpty {
                    Text(desc)
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                triggerBox
                stepsBox

                HStack(spacing: 12) {
                    Button {
                        onRun()
                    } label: {
                        if actionBusy { ProgressView().controlSize(.small) }
                        else { Label("手動執行", systemImage: "play.fill") }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(actionBusy || !detail.enabled)

                    Button {
                        onTest()
                    } label: {
                        Label("測試", systemImage: "flask")
                    }
                    .disabled(actionBusy)

                    Spacer()
                }

                if !actionMessage.isEmpty {
                    Text(actionMessage)
                        .font(.caption)
                        .foregroundStyle(actionMessage.contains("失敗") ? .red : .secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var triggerBox: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                row("類型", triggerTypeLabel(triggerType))
                if let cron = detail.trigger?["cron"]?.stringValue {
                    row("Cron", cron)
                }
                if case .array(let keywords) = detail.trigger?["keywords"] {
                    let list = keywords.compactMap(\.stringValue).joined(separator: "、")
                    if !list.isEmpty {
                        row("關鍵字", list)
                    }
                }
                if let trigger = detail.trigger {
                    Text(trigger.displaySummary)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .textSelection(.enabled)
                }
            }
            .padding(4)
        } label: {
            Text("觸發條件")
        }
    }

    private var stepsBox: some View {
        GroupBox {
            let steps = detail.steps ?? []
            if steps.isEmpty {
                Text("尚無步驟").font(.caption).foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                        HStack(alignment: .top, spacing: 10) {
                            Text("\(index + 1)")
                                .font(.caption2).bold()
                                .frame(width: 20, height: 20)
                                .background(Color.accentColor.opacity(0.15), in: Circle())
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 8) {
                                    Text(step["type"]?.stringValue ?? "—")
                                        .font(.callout).bold()
                                    if let key = step["stepKey"]?.stringValue ?? step["key"]?.stringValue {
                                        Text(key)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                if let config = step["config"] {
                                    Text("config: \(config.displaySummary)")
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                        .textSelection(.enabled)
                                }
                            }
                            Spacer()
                        }
                        if index < steps.count - 1 { Divider() }
                    }
                }
            }
        } label: {
            Text("步驟（\(detail.steps?.count ?? 0)）")
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
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

    private func triggerTypeLabel(_ type: String) -> String {
        switch type.lowercased() {
        case "schedule": return "定期排程"
        case "keyword": return "關鍵字"
        case "manual": return "手動"
        case "webhook": return "Webhook"
        case "event": return "事件"
        default: return type
        }
    }
}

// MARK: - Badges

private struct EnabledBadge: View {
    let enabled: Bool

    var body: some View {
        Text(enabled ? "啟用" : "停用")
            .font(.caption2).bold()
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background((enabled ? Color.green : Color.secondary).opacity(0.15), in: Capsule())
            .foregroundStyle(enabled ? .green : .secondary)
    }
}

private struct TriggerTypeBadge: View {
    let type: String

    private var label: String {
        switch type.lowercased() {
        case "schedule": return "排程"
        case "keyword": return "關鍵字"
        case "manual": return "手動"
        case "webhook": return "Webhook"
        case "event": return "事件"
        default: return type
        }
    }

    var body: some View {
        Text(label)
            .font(.caption2)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Color.blue.opacity(0.12), in: Capsule())
            .foregroundStyle(.blue)
    }
}
