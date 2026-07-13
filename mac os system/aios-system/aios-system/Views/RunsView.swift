import SwiftUI

/// Runs (執行) list + detail: browse recent runs, drill into the ordered
/// step timeline, and cancel runs that are still in progress.
struct RunsView: View {
    @Environment(AppState.self) private var app

    @State private var runs: [RunSummary] = []
    @State private var selectedId: String?
    @State private var detail: RunDetail?

    @State private var loadingList = false
    @State private var loadingDetail = false
    @State private var errorText: String?
    @State private var cancelling = false
    @State private var expandedSteps: Set<String> = []

    var body: some View {
        NavigationSplitView {
            List(runs, selection: $selectedId) { run in
                RunRowView(run: run).tag(run.id)
            }
            .navigationTitle("執行")
            .frame(minWidth: 260)
            .overlay {
                if loadingList && runs.isEmpty { ProgressView() }
                else if runs.isEmpty && !loadingList { ContentUnavailableView("尚無執行紀錄", systemImage: "play.circle") }
            }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { Task { await loadRuns() } } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(loadingList)
                }
            }
        } detail: {
            detailContent
        }
        .task { await loadRuns() }
        .onChange(of: selectedId) { _, newValue in
            expandedSteps = []
            Task { await loadDetail(id: newValue) }
        }
        .onChange(of: app.activity.count) { _, _ in
            guard hasRunEvent() else { return }
            Task {
                await loadRuns(silent: true)
                if let id = selectedId { await loadDetail(id: id, silent: true) }
            }
        }
    }

    @ViewBuilder
    private var detailContent: some View {
        if loadingDetail && detail == nil {
            ProgressView().navigationTitle("")
        } else if let detail {
            RunDetailContentView(
                detail: detail,
                cancelling: cancelling,
                expandedSteps: $expandedSteps,
                onCancel: { Task { await cancelRun(detail.id) } }
            )
        } else if let errorText {
            ContentUnavailableView(errorText, systemImage: "exclamationmark.triangle")
        } else {
            ContentUnavailableView("選擇一個執行以查看詳情", systemImage: "list.bullet.rectangle")
        }
    }

    private func hasRunEvent() -> Bool {
        app.activity.first?.topic.hasPrefix("run.") ?? false
    }

    private func loadRuns(silent: Bool = false) async {
        if !silent { loadingList = true }
        defer { loadingList = false }
        do {
            runs = try await APIClient.shared.request("/api/runs?limit=50")
            if selectedId == nil, let first = runs.first { selectedId = first.id }
        } catch let e as APIClient.APIError {
            if !silent { errorText = e.message }
        } catch {
            if !silent { errorText = "載入執行列表失敗" }
        }
    }

    private func loadDetail(id: String?, silent: Bool = false) async {
        guard let id else { detail = nil; return }
        if !silent { loadingDetail = true; errorText = nil }
        defer { loadingDetail = false }
        do {
            detail = try await APIClient.shared.request("/api/runs/\(id)")
        } catch let e as APIClient.APIError {
            if !silent { errorText = e.message; detail = nil }
        } catch {
            if !silent { errorText = "載入執行詳情失敗"; detail = nil }
        }
    }

    private func cancelRun(_ id: String) async {
        cancelling = true
        defer { cancelling = false }
        struct Empty: Decodable {}
        do {
            let _: Empty = try await APIClient.shared.request("/api/runs/\(id)/cancel", method: "POST")
            await loadRuns(silent: true)
            await loadDetail(id: id, silent: true)
        } catch {
            errorText = "取消失敗"
        }
    }
}

/// Response shape for GET /api/runs/:id — run fields plus its ordered steps.
struct RunDetail: Decodable, Identifiable {
    let id: String
    let agentId: String
    let workflowId: String?
    let status: String
    let triggeredBy: String
    let startedAt: String
    let finishedAt: String?
    let steps: [RunStepRow]
}

private struct RunRowView: View {
    let run: RunSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                StatusBadge(status: run.status)
                Text(run.agentId).font(.subheadline).bold().lineLimit(1)
                Spacer()
            }
            HStack(spacing: 6) {
                Text("由 \(run.triggeredBy)")
                Text("·")
                Text(formatDate(run.startedAt))
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}

private struct RunDetailContentView: View {
    let detail: RunDetail
    let cancelling: Bool
    @Binding var expandedSteps: Set<String>
    let onCancel: () -> Void

    var body: some View {
        List {
            Section {
                LabeledContent("代理", value: detail.agentId)
                if let wf = detail.workflowId {
                    LabeledContent("工作流程", value: wf)
                }
                LabeledContent("觸發者", value: detail.triggeredBy)
                LabeledContent("開始時間", value: formatDate(detail.startedAt))
                if let finishedAt = detail.finishedAt {
                    LabeledContent("結束時間", value: formatDate(finishedAt))
                }
                LabeledContent {
                    StatusBadge(status: detail.status)
                } label: {
                    Text("狀態")
                }
            } header: {
                Text("執行 \(detail.id)")
            }

            Section("步驟時間軸") {
                if detail.steps.isEmpty {
                    Text("尚無步驟").foregroundStyle(.secondary)
                } else {
                    ForEach(detail.steps) { step in
                        StepRowView(
                            step: step,
                            expanded: expandedSteps.contains(step.id),
                            onToggle: { toggle(step.id) }
                        )
                    }
                }
            }
        }
        .navigationTitle("執行詳情")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                if detail.status.uppercased() == "RUNNING" {
                    Button(role: .destructive) {
                        onCancel()
                    } label: {
                        if cancelling { ProgressView().controlSize(.small) }
                        else { Text("取消") }
                    }
                    .disabled(cancelling)
                }
            }
        }
    }

    private func toggle(_ id: String) {
        if expandedSteps.contains(id) { expandedSteps.remove(id) }
        else { expandedSteps.insert(id) }
    }
}

private struct StepRowView: View {
    let step: RunStepRow
    let expanded: Bool
    let onToggle: () -> Void

    private var hasDetail: Bool {
        !(step.output ?? "").isEmpty || !(step.verdict ?? "").isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: onToggle) {
                HStack {
                    Text("第 \(step.round) 輪").font(.caption).foregroundStyle(.secondary)
                    Text(step.stepKey).font(.body).bold()
                    StatusBadge(status: step.status)
                    if let approved = step.approved {
                        Image(systemName: approved ? "checkmark.circle.fill" : "xmark.circle")
                            .foregroundStyle(approved ? .green : .secondary)
                    }
                    Spacer()
                    if hasDetail {
                        Image(systemName: expanded ? "chevron.up" : "chevron.down")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .buttonStyle(.plain)
            .disabled(!hasDetail)

            if expanded {
                if let verdict = step.verdict, !verdict.isEmpty {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("判定").font(.caption).foregroundStyle(.secondary)
                        Text(verdict).font(.callout).textSelection(.enabled)
                    }
                }
                if let output = step.output, !output.isEmpty {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("輸出").font(.caption).foregroundStyle(.secondary)
                        Text(output)
                            .font(.system(.callout, design: .monospaced))
                            .textSelection(.enabled)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }
}

private struct StatusBadge: View {
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

private func formatDate(_ iso: String) -> String {
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
