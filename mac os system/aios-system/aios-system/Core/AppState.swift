import Foundation
import Observation

/// Top-level app model: session, realtime connection, and a live feed of run
/// events surfaced from the AWP/1 hub.
@Observable
@MainActor
final class AppState {
    var user: AIOSUser?
    var booting = true
    var preflight: Preflight?

    let awp = AwpClient()
    var connected: Bool { awp.connected }

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
    }

    private func startRealtime() {
        awp.connect(topics: ["run.*", "agent.status", "integration.status", "skill.review_ready", "workflow.triggered", "schedule.fired", "computer.control_requested"])
    }

    private func ingest(_ frame: AwpFrame) {
        guard let topic = frame.topic else { return }
        // Computer-control requests are handed to the host executor.
        if topic == "computer.control_requested" {
            ComputerControlExecutor.shared.handle(frame, awp: awp)
        }
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
        default: return frame.topic ?? ""
        }
    }
}
