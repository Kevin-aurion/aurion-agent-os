import SwiftUI
import AppKit

/// Compact popover content for the MenuBarExtra (.window style).
struct MenuBarView: View {
    @Environment(AppState.self) private var app

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            Divider()

            activityList

            Divider()

            actions
        }
        .frame(width: 320)
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(app.connected ? Color.green : Color.red)
                .frame(width: 8, height: 8)
            Text(app.connected ? "已連線" : "未連線")
                .font(.subheadline)
                .fontWeight(.medium)
            Spacer()
            if let user = app.user {
                Text(user.displayName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    // MARK: - Activity

    private var activityList: some View {
        Group {
            if app.activity.isEmpty {
                Text("尚無活動")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 16)
                    .frame(maxWidth: .infinity)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(app.activity.prefix(10))) { item in
                        ActivityRow(item: item)
                    }
                }
                .padding(.vertical, 4)
            }
        }
        .frame(maxHeight: 320)
    }

    // MARK: - Actions

    private var actions: some View {
        VStack(spacing: 6) {
            Button {
                bringMainWindowToFront()
            } label: {
                Label("開啟主視窗", systemImage: "macwindow")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)

            Button(role: .destructive) {
                app.logout()
            } label: {
                Label("登出", systemImage: "rectangle.portrait.and.arrow.right")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 6)
    }

    private func bringMainWindowToFront() {
        NSApp.activate(ignoringOtherApps: true)
        for window in NSApp.windows {
            if window.canBecomeMain {
                window.makeKeyAndOrderFront(nil)
                break
            }
        }
    }
}

private struct ActivityRow: View {
    let item: AppState.ActivityItem

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon(for: item.topic))
                .foregroundStyle(.secondary)
                .frame(width: 16)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 1) {
                Text(item.text)
                    .font(.caption)
                    .lineLimit(2)
                Text(relativeTime(item.at))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
    }

    private func icon(for topic: String) -> String {
        if topic.hasPrefix("run.") { return "bolt.fill" }
        switch topic {
        case "agent.status": return "person.crop.circle"
        case "integration.status": return "link"
        case "skill.review_ready": return "checkmark.seal"
        case "workflow.triggered": return "arrow.triangle.branch"
        case "schedule.fired": return "clock"
        case "computer.control_requested": return "desktopcomputer"
        default: return "circle.fill"
        }
    }

    private func relativeTime(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        formatter.locale = Locale(identifier: "zh_TW")
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
