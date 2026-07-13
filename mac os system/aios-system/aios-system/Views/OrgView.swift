//
//  OrgView.swift
//  aios-system
//
//  組織圖：OWNER / TRAINER / MEMBER 與部門員工；OWNER 可切換角色。
//

import SwiftUI

struct OrgView: View {
    @Environment(AppState.self) private var app

    @State private var org: OrgResponse?
    @State private var loading = false
    @State private var errorText = ""
    @State private var roleBusyId: String?

    private var isOwner: Bool {
        app.user?.role == "OWNER"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if loading && org == nil {
                    ProgressView("載入組織…")
                        .frame(maxWidth: .infinity)
                        .padding(.top, 40)
                } else if let org {
                    peopleSection(org)
                    departmentsSection(org)
                } else if !errorText.isEmpty {
                    ContentUnavailableView(errorText, systemImage: "exclamationmark.triangle")
                } else {
                    ContentUnavailableView("尚無組織資料", systemImage: "building.2")
                }

                if !errorText.isEmpty, org != nil {
                    Text(errorText)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
            .padding(20)
        }
        .navigationTitle("組織")
        .toolbar {
            ToolbarItem {
                Button { Task { await load() } } label: {
                    Label("重新整理", systemImage: "arrow.clockwise")
                }
                .disabled(loading)
            }
        }
        .task { await load() }
    }

    // MARK: People

    @ViewBuilder
    private func peopleSection(_ org: OrgResponse) -> some View {
        // Backend includes OWNER in trainers (OWNER || TRAINER); keep owner only in the OWNER card.
        let ownerId = org.owner?.id
        let trainers = org.trainers.filter { $0.id != ownerId }
        let members = org.members.filter { $0.id != ownerId }

        VStack(alignment: .leading, spacing: 12) {
            Text("成員").font(.title3).bold()

            if let owner = org.owner {
                GroupBox {
                    PersonRow(
                        user: owner,
                        roleOverride: "OWNER",
                        canEdit: false,
                        busy: false,
                        onSetRole: { _ in }
                    )
                } label: {
                    Label("擁有者 (OWNER)", systemImage: "crown.fill")
                }
            }

            GroupBox {
                if trainers.isEmpty {
                    Text("尚無訓練師").font(.caption).foregroundStyle(.secondary)
                } else {
                    VStack(spacing: 0) {
                        ForEach(trainers) { user in
                            PersonRow(
                                user: user,
                                roleOverride: user.role ?? "TRAINER",
                                canEdit: isOwner && (user.role != "OWNER"),
                                busy: roleBusyId == user.id,
                                onSetRole: { role in Task { await setRole(user.id, role: role) } }
                            )
                            if user.id != trainers.last?.id { Divider() }
                        }
                    }
                }
            } label: {
                Label("訓練師 (TRAINER)", systemImage: "person.badge.shield.checkmark")
            }

            GroupBox {
                if members.isEmpty {
                    Text("尚無成員").font(.caption).foregroundStyle(.secondary)
                } else {
                    VStack(spacing: 0) {
                        ForEach(members) { user in
                            PersonRow(
                                user: user,
                                roleOverride: user.role ?? "MEMBER",
                                canEdit: isOwner,
                                busy: roleBusyId == user.id,
                                onSetRole: { role in Task { await setRole(user.id, role: role) } }
                            )
                            if user.id != members.last?.id { Divider() }
                        }
                    }
                }
            } label: {
                Label("成員 (MEMBER)", systemImage: "person.3")
            }
        }
    }

    // MARK: Departments

    @ViewBuilder
    private func departmentsSection(_ org: OrgResponse) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("部門員工").font(.title3).bold()
            if org.departments.isEmpty {
                Text("尚無部門資料").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(org.departments) { dept in
                    GroupBox {
                        if dept.agents.isEmpty {
                            Text("此部門尚無員工").font(.caption).foregroundStyle(.secondary)
                        } else {
                            VStack(spacing: 0) {
                                ForEach(dept.agents) { agent in
                                    VStack(alignment: .leading, spacing: 6) {
                                        HStack(alignment: .top) {
                                            VStack(alignment: .leading, spacing: 2) {
                                                Text(agent.name).font(.body).bold()
                                                if let desc = agent.description, !desc.isEmpty {
                                                    Text(desc)
                                                        .font(.caption)
                                                        .foregroundStyle(.secondary)
                                                        .lineLimit(2)
                                                        .fixedSize(horizontal: false, vertical: true)
                                                }
                                            }
                                            Spacer(minLength: 8)
                                            StatusPill(status: agent.status)
                                        }
                                        HStack(spacing: 10) {
                                            if let sc = agent.skillCount {
                                                Text("技能 \(sc)").font(.caption2).foregroundStyle(.secondary)
                                            }
                                            if let wc = agent.workflowCount {
                                                Text("工作流 \(wc)").font(.caption2).foregroundStyle(.secondary)
                                            }
                                        }
                                    }
                                    .padding(.vertical, 6)
                                    if agent.id != dept.agents.last?.id { Divider() }
                                }
                            }
                        }
                    } label: {
                        Label(dept.name, systemImage: "folder")
                    }
                }
            }
        }
    }

    // MARK: API

    private func load() async {
        loading = true
        errorText = ""
        do {
            org = try await APIClient.shared.request("/api/org")
        } catch let e as APIClient.APIError {
            errorText = e.message
        } catch {
            errorText = "載入組織失敗"
        }
        loading = false
    }

    private func setRole(_ userId: String, role: String) async {
        roleBusyId = userId
        errorText = ""
        struct Body: Encodable { let role: String }
        do {
            let _: OrgUser = try await APIClient.shared.request(
                "/api/users/\(userId)/role",
                method: "PATCH",
                body: Body(role: role)
            )
            await load()
        } catch let e as APIClient.APIError {
            errorText = e.message
        } catch {
            errorText = "變更角色失敗"
        }
        roleBusyId = nil
    }
}

// MARK: - Person row

private struct PersonRow: View {
    let user: OrgUser
    let roleOverride: String
    let canEdit: Bool
    let busy: Bool
    let onSetRole: (String) -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "person.crop.circle.fill")
                .font(.title2)
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(user.displayName).font(.body).bold()
                Text(user.email).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            RoleBadge(role: roleOverride)
            if canEdit {
                if busy {
                    ProgressView().controlSize(.small)
                } else {
                    Menu {
                        Button("設為訓練師 (TRAINER)") { onSetRole("TRAINER") }
                            .disabled(roleOverride == "TRAINER" || roleOverride == "OWNER")
                        Button("設為成員 (MEMBER)") { onSetRole("MEMBER") }
                            .disabled(roleOverride == "MEMBER")
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .menuStyle(.borderlessButton)
                    .frame(width: 28)
                    .help("變更角色")
                }
            }
        }
        .padding(.vertical, 6)
    }
}

private struct RoleBadge: View {
    let role: String

    private var color: Color {
        switch role.uppercased() {
        case "OWNER": return .orange
        case "TRAINER": return .blue
        case "MEMBER": return .secondary
        default: return .gray
        }
    }

    var body: some View {
        Text(role)
            .font(.caption2).bold()
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }
}

private struct StatusPill: View {
    let status: String

    private var color: Color {
        switch status.uppercased() {
        case "ACTIVE": return .green
        case "PAUSED": return .orange
        case "ARCHIVED": return .secondary
        default: return .gray
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
