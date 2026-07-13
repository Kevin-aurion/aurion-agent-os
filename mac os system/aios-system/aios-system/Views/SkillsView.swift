//
//  SkillsView.swift
//  aios-system
//
//  技能列表、訓練新技能、確認 / 拒絕掛載。
//

import SwiftUI

struct SkillsView: View {
    @Environment(AppState.self) private var app

    @State private var skills: [Skill] = []
    @State private var selectedId: String?
    @State private var loading = false
    @State private var errorText = ""
    @State private var showBuild = false
    @State private var actionBusy = false

    private var selected: Skill? {
        skills.first(where: { $0.id == selectedId })
    }

    var body: some View {
        HSplitView {
            // 左：技能清單
            VStack(spacing: 0) {
                Group {
                    if loading && skills.isEmpty {
                        ProgressView("載入技能…").frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else if skills.isEmpty {
                        ContentUnavailableView(
                            "尚無技能",
                            systemImage: "wrench.and.screwdriver",
                            description: Text("點擊右上角「＋」訓練新技能")
                        )
                    } else {
                        List(skills, selection: $selectedId) { skill in
                            SkillRow(skill: skill).tag(skill.id)
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
                if let skill = selected {
                    SkillDetailPane(
                        skill: skill,
                        actionBusy: actionBusy,
                        onConfirm: { Task { await confirm(skill.id) } },
                        onReject: { reason in Task { await reject(skill.id, reason: reason) } }
                    )
                } else {
                    ContentUnavailableView(
                        "選擇一項技能",
                        systemImage: "wrench.and.screwdriver",
                        description: Text("從左側清單選擇以查看詳情與審核")
                    )
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .navigationTitle("技能")
        .toolbar {
            ToolbarItem {
                Button { showBuild = true } label: {
                    Label("訓練新技能", systemImage: "plus")
                }
            }
            ToolbarItem {
                Button { Task { await load() } } label: {
                    Label("重新整理", systemImage: "arrow.clockwise")
                }
                .disabled(loading)
            }
        }
        .task { await load() }
        .sheet(isPresented: $showBuild) {
            BuildSkillSheet {
                Task { await load() }
            }
        }
    }

    private func load() async {
        loading = true
        do {
            skills = try await APIClient.shared.request("/api/skills")
            errorText = ""
            if selectedId == nil { selectedId = skills.first?.id }
            // Keep selection valid after reload
            if let id = selectedId, !skills.contains(where: { $0.id == id }) {
                selectedId = skills.first?.id
            }
        } catch let e as APIClient.APIError {
            errorText = e.message
        } catch {
            errorText = "載入技能失敗"
        }
        loading = false
    }

    private func confirm(_ id: String) async {
        actionBusy = true
        errorText = ""
        do {
            let updated: Skill = try await APIClient.shared.request(
                "/api/skills/\(id)/confirm", method: "POST"
            )
            if let idx = skills.firstIndex(where: { $0.id == id }) {
                skills[idx] = updated
            }
        } catch let e as APIClient.APIError {
            errorText = e.message
        } catch {
            errorText = "確認掛載失敗"
        }
        actionBusy = false
    }

    private func reject(_ id: String, reason: String?) async {
        actionBusy = true
        errorText = ""
        struct Body: Encodable { let reason: String? }
        do {
            let updated: Skill = try await APIClient.shared.request(
                "/api/skills/\(id)/reject",
                method: "POST",
                body: Body(reason: reason)
            )
            if let idx = skills.firstIndex(where: { $0.id == id }) {
                skills[idx] = updated
            }
        } catch let e as APIClient.APIError {
            errorText = e.message
        } catch {
            errorText = "拒絕失敗"
        }
        actionBusy = false
    }
}

// MARK: - Row

private struct SkillRow: View {
    let skill: Skill

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(skill.name).font(.body).bold().lineLimit(1)
                Spacer()
                ReviewStatusBadge(status: skill.reviewStatus)
            }
            HStack(spacing: 6) {
                CapsuleLabel(text: skill.kind, color: .blue)
                CapsuleLabel(text: skill.executionEnv, color: .purple)
                if let version = skill.version {
                    Text("v\(version)").font(.caption2).foregroundStyle(.secondary)
                }
            }
            .lineLimit(1)
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Detail

private struct SkillDetailPane: View {
    let skill: Skill
    let actionBusy: Bool
    let onConfirm: () -> Void
    let onReject: (String?) -> Void

    @State private var rejectReason = ""
    @State private var showReject = false

    private var awaitingConfirm: Bool {
        skill.reviewStatus == "AWAITING_USER_CONFIRM"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                metaBox
                if awaitingConfirm {
                    understandingCard
                    actions
                } else if skill.understanding != nil {
                    understandingCard
                }
                contentPreview
            }
            .padding(20)
        }
        .navigationTitle(skill.name)
        .alert("拒絕技能", isPresented: $showReject) {
            TextField("原因（可選）", text: $rejectReason)
            Button("取消", role: .cancel) {}
            Button("確認拒絕", role: .destructive) {
                onReject(rejectReason.isEmpty ? nil : rejectReason)
                rejectReason = ""
            }
        } message: {
            Text("拒絕後此技能將標記為 REJECTED，無法掛載至員工。")
        }
    }

    private var header: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                ReviewStatusBadge(status: skill.reviewStatus)
                CapsuleLabel(text: skill.kind, color: .blue)
                CapsuleLabel(text: skill.executionEnv, color: .purple)
                Spacer(minLength: 0)
            }
            VStack(alignment: .leading, spacing: 6) {
                ReviewStatusBadge(status: skill.reviewStatus)
                HStack(spacing: 8) {
                    CapsuleLabel(text: skill.kind, color: .blue)
                    CapsuleLabel(text: skill.executionEnv, color: .purple)
                }
            }
        }
    }

    private var metaBox: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                metaRow("Slug", skill.slug ?? "—")
                metaRow("版本", skill.version.map(String.init) ?? "—")
                if let origin = skill.origin {
                    metaRow("來源", origin)
                }
                if let generator = skill.generator {
                    metaRow("產生引擎", generator)
                }
            }
            .padding(4)
        } label: {
            Text("基本資訊")
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

    @ViewBuilder
    private var understandingCard: some View {
        if let understanding = skill.understanding {
            GroupBox {
                VStack(alignment: .leading, spacing: 10) {
                    understandingSection("讀取", items: arrayStrings(understanding["reads"]))
                    understandingSection("寫入", items: arrayStrings(understanding["writes"]))
                    understandingSection("風險", items: arrayStrings(understanding["risks"]))
                    if case .object(let obj) = understanding {
                        let known: Set<String> = ["reads", "writes", "risks"]
                        let extras = obj.keys.filter { !known.contains($0) }.sorted()
                        if !extras.isEmpty {
                            Divider()
                            ForEach(extras, id: \.self) { key in
                                HStack(alignment: .top) {
                                    Text(key).font(.caption).foregroundStyle(.secondary).frame(width: 80, alignment: .leading)
                                    Text(obj[key]?.displaySummary ?? "—")
                                        .font(.caption)
                                        .textSelection(.enabled)
                                }
                            }
                        }
                    }
                }
                .padding(4)
            } label: {
                Label("引擎理解摘要", systemImage: "brain")
            }
        } else if awaitingConfirm {
            Text("尚無理解摘要，請稍候引擎分析完成。")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func understandingSection(_ title: String, items: [String]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).bold().foregroundStyle(.secondary)
            if items.isEmpty {
                Text("—").font(.caption).foregroundStyle(.tertiary)
            } else {
                ForEach(items, id: \.self) { item in
                    HStack(alignment: .top, spacing: 6) {
                        Text("•").foregroundStyle(.secondary)
                        Text(item).font(.callout).textSelection(.enabled)
                    }
                }
            }
        }
    }

    private var actions: some View {
        HStack(spacing: 12) {
            Button {
                onConfirm()
            } label: {
                if actionBusy { ProgressView().controlSize(.small) }
                else { Label("確認掛載", systemImage: "checkmark.seal.fill") }
            }
            .buttonStyle(.borderedProminent)
            .disabled(actionBusy)

            Button(role: .destructive) {
                showReject = true
            } label: {
                Label("拒絕", systemImage: "xmark.circle")
            }
            .disabled(actionBusy)

            Spacer()
        }
    }

    private var contentPreview: some View {
        GroupBox {
            Text(skill.contentMd)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(4)
        } label: {
            Text("內容預覽")
        }
    }

    private func arrayStrings(_ value: JSONValue?) -> [String] {
        guard let value else { return [] }
        switch value {
        case .array(let arr):
            return arr.compactMap { item in
                switch item {
                case .string(let s): return s
                default: return item.displaySummary
                }
            }
        case .string(let s): return [s]
        default: return [value.displaySummary]
        }
    }
}

// MARK: - Build sheet

private struct BuildSkillSheet: View {
    @Environment(\.dismiss) private var dismiss
    var onBuilt: () -> Void

    @State private var name = ""
    @State private var description = ""
    @State private var contentMd = ""
    @State private var engine = "CLAUDE_CODE"
    @State private var executionEnv = "CLI"
    @State private var busy = false
    @State private var errorText = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("基本資訊") {
                    TextField("名稱", text: $name)
                    TextField("描述", text: $description, axis: .vertical)
                        .lineLimit(2...4)
                }
                Section("技能內容") {
                    TextEditor(text: $contentMd)
                        .font(.system(.body, design: .monospaced))
                        .frame(minHeight: 140)
                    Text("可填寫需求說明或 SKILL.md 草稿；後端會以引擎非同步草擬並分析。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Section("執行設定") {
                    Picker("訓練引擎", selection: $engine) {
                        Text("Claude Code").tag("CLAUDE_CODE")
                        Text("Codex").tag("CODEX")
                        Text("Grok").tag("GROK")
                    }
                    Picker("執行環境", selection: $executionEnv) {
                        Text("CLI").tag("CLI")
                        Text("桌面 App").tag("DESKTOP_APP")
                        Text("Direct").tag("DIRECT")
                    }
                }
                if !errorText.isEmpty {
                    Section {
                        Text(errorText).font(.caption).foregroundStyle(.red)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("訓練新技能")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("開始訓練") { submit() }
                        .disabled(busy || !canSubmit)
                }
            }
        }
        .frame(minWidth: 480, minHeight: 420)
    }

    private var canSubmit: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !contentMd.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func submit() {
        busy = true
        errorText = ""
        // Backend POST /api/skills/build expects { requirement, engine, executionEnv? }
        // Compose UI fields into a single requirement string.
        let requirement = [
            name.trimmingCharacters(in: .whitespacesAndNewlines),
            description.trimmingCharacters(in: .whitespacesAndNewlines),
            contentMd.trimmingCharacters(in: .whitespacesAndNewlines),
        ]
        .filter { !$0.isEmpty }
        .joined(separator: "\n\n")

        struct Body: Encodable {
            let requirement: String
            let engine: String
            let executionEnv: String
        }
        Task {
            do {
                let _: Skill = try await APIClient.shared.request(
                    "/api/skills/build",
                    method: "POST",
                    body: Body(requirement: requirement, engine: engine, executionEnv: executionEnv)
                )
                onBuilt()
                dismiss()
            } catch let e as APIClient.APIError {
                errorText = e.message
            } catch {
                errorText = "訓練請求失敗"
            }
            busy = false
        }
    }
}

// MARK: - Badges

private struct ReviewStatusBadge: View {
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
        case "PENDING_UNDERSTANDING": return .orange
        case "AWAITING_USER_CONFIRM": return .blue
        case "CONFIRMED": return .green
        case "REJECTED": return .red
        default: return .secondary
        }
    }

    var body: some View {
        Text(label)
            .font(.caption2).bold()
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }
}

private struct CapsuleLabel: View {
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
