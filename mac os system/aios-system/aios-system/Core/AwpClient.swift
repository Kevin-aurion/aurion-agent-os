import Foundation
import Observation

/// AWP/1 client over URLSessionWebSocketTask. Connect → subscribe → ping/pong →
/// reconnect with backoff → resume via lastSeq. Same protocol as the web client.
///
/// User-hub only (`/ws` + JWT). Device work uses `DeviceChannel` on `/device/ws`.
@Observable
final class AwpClient: NSObject {
    private(set) var connected = false
    private var task: URLSessionWebSocketTask?
    private var session: URLSession!
    private var lastSeq = 0
    private var backoff: TimeInterval = 1
    private var topics: [String] = []
    private var closedByUs = false

    /// Registered per-topic event handlers. Payload is the decoded frame.
    var onEvent: ((AwpFrame) -> Void)?

    override init() {
        super.init()
        session = URLSession(configuration: .default)
    }

    func connect(topics: [String]) {
        self.topics = topics
        closedByUs = false
        openSocket()
    }

    private func openSocket() {
        guard let token = Keychain.get("access") else { return }
        // User hub may put JWT in query (existing contract). Device channel never does.
        let t = session.webSocketTask(with: AIOSConfig.userWsURL(token: token))
        task = t
        t.resume()
        connected = true
        backoff = 1
        subscribe()
        receiveLoop()
        schedulePing()
    }

    private func subscribe() {
        send(kind: "req", topic: "sub", payload: ["topics": topics, "lastSeq": lastSeq])
    }

    func send(kind: String, topic: String? = nil, reqId: String? = nil, payload: [String: Any] = [:]) {
        var obj: [String: Any] = [
            "v": 1,
            "id": UUID().uuidString,
            "kind": kind,
            "ts": ISO8601DateFormatter().string(from: Date()),
        ]
        if let topic { obj["topic"] = topic }
        if let reqId { obj["reqId"] = reqId }
        if !payload.isEmpty { obj["payload"] = payload }
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        task?.send(.data(data)) { _ in }
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure:
                self.handleDisconnect()
            case .success(let msg):
                let data: Data? = {
                    switch msg {
                    case .data(let d): return d
                    case .string(let s): return s.data(using: .utf8)
                    @unknown default: return nil
                    }
                }()
                if let data, let frame = try? JSONDecoder().decode(AwpFrame.self, from: data) {
                    self.handle(frame)
                }
                self.receiveLoop()
            }
        }
    }

    private func handle(_ frame: AwpFrame) {
        if frame.kind == "ping" { send(kind: "pong", reqId: frame.id); return }
        if let seq = frame.seq { lastSeq = max(lastSeq, seq) }
        if frame.kind == "event" {
            DispatchQueue.main.async { self.onEvent?(frame) }
        }
    }

    private func schedulePing() {
        DispatchQueue.global().asyncAfter(deadline: .now() + 25) { [weak self] in
            guard let self, self.connected else { return }
            self.send(kind: "ping")
            self.schedulePing()
        }
    }

    private func handleDisconnect() {
        connected = false
        task = nil
        if closedByUs { return }
        DispatchQueue.global().asyncAfter(deadline: .now() + backoff) { [weak self] in
            guard let self, !self.closedByUs else { return }
            self.backoff = min(self.backoff * 2, 10)
            self.openSocket()
        }
    }

    func disconnect() {
        closedByUs = true
        connected = false
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }
}
