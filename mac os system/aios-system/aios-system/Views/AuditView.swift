//
//  AuditView.swift
//  aios-system
//
//  稽核紀錄列表，將 action / entity 轉成繁體中文。
//

import SwiftUI

struct AuditView: View {
    @State private var entries: [AuditEntry] = []
    @State private var loading = false
    @State private var errorText = ""

    var body: some View {
        Group {
            if loading && entries.isEmpty {
                ProgressView("載入稽核紀錄…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if entries.isEmpty {
                ContentUnavailableView(
                    "尚無稽核紀錄",
                    systemImage: "doc.text.magnifyingglass",
                    description: Text(errorText.isEmpty ? "系統操作紀錄會顯示於此" : errorText)
                )
            } else {
                List(entries) { entry in
                    AuditRow(entry: entry)
                }
            }
        }
        .navigationTitle("稽核")
        .toolbar {
            ToolbarItem {
                Button { Task { await load() } } label: {
                    Label("重新整理", systemImage: "arrow.clockwise")
                }
                .disabled(loading)
            }
        }
        .safeAreaInset(edge: .bottom) {
            if !errorText.isEmpty, !entries.isEmpty {
                Text(errorText)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .task { await load() }
    }

    private func load() async {
        loading = true
        errorText = ""
        do {
            entries = try await APIClient.shared.request("/api/audit?limit=50")
        } catch let e as APIClient.APIError {
            errorText = e.message
        } catch {
            errorText = "載入稽核紀錄失敗"
        }
        loading = false
    }
}

// MARK: - Row

private struct AuditRow: View {
    let entry: AuditEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(AuditLabels.action(entry.action))
                    .font(.body).bold()
                    .lineLimit(1)
                Spacer()
                Text(formatDate(entry.createdAt))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 8) {
                CapsuleTag(text: AuditLabels.entity(entry.entity), color: .blue)
                Text(shortId(entry.entityId))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                if let userId = entry.userId {
                    Text("使用者 \(shortId(userId))")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            if let detail = entry.detail, case .null = detail {
                EmptyView()
            } else if let detail = entry.detail {
                Text(detail.displaySummary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .textSelection(.enabled)
            }
            // Fallback raw action when untranslated
            if AuditLabels.action(entry.action) == entry.action {
                Text(entry.action)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 4)
    }

    private func shortId(_ id: String) -> String {
        id.count > 12 ? String(id.prefix(10)) + "…" : id
    }
}

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

// MARK: - Labels

private enum AuditLabels {
    static let actionMap: [String: String] = [
        "agent.created": "建立員工",
        "agent.updated": "更新員工",
        "agent.deleted": "刪除員工",
        "skill.created": "建立技能",
        "skill.build": "訓練技能",
        "skill.confirm": "確認技能",
        "skill.reject": "拒絕技能",
        "skill.updated": "更新技能",
        "skill.deleted": "刪除技能",
        "skill.upload": "上傳技能",
        "workflow.created": "建立工作流",
        "workflow.update": "更新工作流",
        "workflow.updated": "更新工作流",
        "workflow.deleted": "刪除工作流",
        "workflow.run": "手動執行工作流",
        "workflow.test": "測試工作流",
        "workflow.steps.replace": "置換工作流步驟",
        "run.start": "開始執行",
        "run.started": "開始執行",
        "run.finished": "結束執行",
        "run.cancel": "取消執行",
        "user.role_changed": "變更使用者角色",
        "user.created": "建立使用者",
        "auth.login": "登入",
        "auth.logout": "登出",
        "integration.connected": "連結整合帳號",
        "integration.disconnected": "解除整合帳號",
    ]

    static let entityMap: [String: String] = [
        "Agent": "員工",
        "Skill": "技能",
        "Workflow": "工作流",
        "Run": "執行",
        "User": "使用者",
        "ConnectedAccount": "整合帳號",
        "Schedule": "排程",
    ]

    static func action(_ raw: String) -> String {
        if let hit = actionMap[raw] { return hit }
        // fuzzy: skill.* / workflow.*
        let lower = raw.lowercased()
        if lower.hasPrefix("agent.") { return "員工操作（\(raw)）" }
        if lower.hasPrefix("skill.") { return "技能操作（\(raw)）" }
        if lower.hasPrefix("workflow.") { return "工作流操作（\(raw)）" }
        if lower.hasPrefix("run.") { return "執行操作（\(raw)）" }
        if lower.hasPrefix("user.") { return "使用者操作（\(raw)）" }
        return raw
    }

    static func entity(_ raw: String) -> String {
        entityMap[raw] ?? raw
    }
}

// MARK: - Date

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
