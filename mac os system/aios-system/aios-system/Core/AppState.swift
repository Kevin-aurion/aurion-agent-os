import Foundation
import Observation

/// Top-level app model: session, realtime connection, and a live feed of run
/// events surfaced from the AWP/1 hub. Device agent is independent of user JWT.
@Observable
@MainActor
final class AppState {
    var user: AIOSUser?
    var booting = true
    var preflight: Preflight?

    let awp = AwpClient()
    var connected: Bool { awp.connected }

    /// Device agent (enrollment, /device/ws, durable tasks).
    let deviceAgent = DeviceAgentService.shared

    /// Recent run/agent events for the menu bar + activity views.
    var activity: [ActivityItem] = []

    struct ActivityItem: Identifiable {
        let id = UUID()
        let topic: String
        let text: String
        let at: Date
    }

    init() {
        awp.onEvent = { [weak self] frame in self?.ingest(frame) }
    }

    func boot() async {
        // Device agent can run without user login.
        await deviceAgent.startIfEnrolled()

        if await APIClient.shared.hasSession {
            do {
                user = try await APIClient.shared.request("/api/auth/me")
                startRealtime()
            } catch { await APIClient.shared.clearTokens() }
        }
        preflight = try? await APIClient.shared.request("/api/preflight")
        booting = false
    }

    func login(email: String, password: String, register: Bool, displayName: String = "") async throws {
        struct Login: Encodable { let email: String; let password: String; let client = "macos" }
        struct Register: Encodable { let email: String; let displayName: String; let password: String }
        let result: AuthResult = register
            ? try await APIClient.shared.request("/api/auth/register", method: "POST", body: Register(email: email, displayName: displayName, password: password), authed: false)
            : try await APIClient.shared.request("/api/auth/login", method: "POST", body: Login(email: email, password: password), authed: false)
        await APIClient.shared.setTokens(access: result.access, refresh: result.refresh)
        user = result.user
        startRealtime()
    }

    func logout() {
        awp.disconnect()
        Task { await APIClient.shared.clearTokens() }
        user = nil
        // Device identity is independent — do not clear on user logout.
    }

    private func startRealtime() {
        // Public user hub. Device tasks do NOT use computer.control_requested.
        awp.connect(topics: [
            "run.*",
            "agent.status",
            "integration.status",
            "skill.review_ready",
            "workflow.triggered",
            "schedule.fired",
            "device.task.*",
            "computer.control_requested", // retired: activity only; never treated as success
        ])
    }

    private func ingest(_ frame: AwpFrame) {
        guard let topic = frame.topic else { return }
        let text = summarize(frame)
        activity.insert(ActivityItem(topic: topic, text: text, at: Date()), at: 0)
        if activity.count > 100 { activity.removeLast(activity.count - 100) }
    }

    private func summarize(_ frame: AwpFrame) -> String {
        let p = frame.payload
        switch frame.topic {
        case "run.started": return "Run 開始"
        case "run.finished": return "Run 結束：\(p?["status"]?.stringValue ?? "")"
        case "run.step": return "步驟 \(p?["stepKey"]?.stringValue ?? "") \(p?["status"]?.stringValue ?? "")"
        case "schedule.fired": return "排程觸發"
        case "skill.review_ready": return "技能待確認"
        case "device.task.create": return "裝置任務建立"
        case "device.task.ack": return "裝置任務已 ACK"
        case "device.task.progress": return "裝置任務進度"
        case "device.task.result": return "裝置任務結果"
        case "device.task.cancel": return "裝置任務取消"
        case "computer.control_requested": return "（已退役）舊版電腦操控請求"
        default: return frame.topic ?? ""
        }
    }
}
