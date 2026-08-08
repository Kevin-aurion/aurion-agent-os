import Foundation

/// Dedicated reconnecting device WebSocket (`/device/ws`).
/// Independent of `AwpClient`. Auth: `Authorization: Bearer` + fixed
/// `Sec-WebSocket-Protocol: aios-device`. Never puts token in URL.
actor DeviceChannel {
    enum Event: Sendable {
        case stateChanged(DeviceConnectionState)
        case hello(deviceId: String, connId: String?)
        case taskWake(taskId: String)
        case taskCancel(taskId: String)
        case taskConfirmed(taskId: String)
        case error(String)
    }

    /// Server close codes that must latch authFailed (no reconnect until re-enroll).
    /// Pure helper for self-tests.
    nonisolated static func isAuthFailureCloseCode(_ code: Int) -> Bool {
        switch code {
        case 4001: return true // revoked (hub.disconnectDevice default)
        case 4002: return true // rotated
        case 1008: return true // policy violation (RFC 6455)
        case 4401, 4403: return true // common unauthorized/forbidden WS codes
        case 4003: return true // reserved for auth/policy if server uses it
        default: return false
        }
    }

    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var state: DeviceConnectionState = .disconnected
    private var closedByUs = false
    private var authFailed = false
    private var backoff: TimeInterval = 1
    private let maxBackoff: TimeInterval = 30
    private var heartbeatTask: Task<Void, Never>?
    private var receiveTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?

    private var eventHandler: (@Sendable (Event) -> Void)?

    func setEventHandler(_ handler: @escaping @Sendable (Event) -> Void) {
        eventHandler = handler
    }

    func currentState() -> DeviceConnectionState { state }

    /// Start connecting if enrolled. No-op when auth-failed until re-enroll.
    func start() {
        closedByUs = false
        // Do not clear authFailed here — only resetAuthAndStart after re-enrollment.
        guard !authFailed else {
            setState(.authFailed)
            return
        }
        guard DeviceIdentityStore.load() != nil else {
            setState(.disconnected)
            return
        }
        openSocket()
    }

    func stop() {
        closedByUs = true
        reconnectTask?.cancel()
        reconnectTask = nil
        teardownSocket()
        setState(.disconnected)
    }

    /// After re-enrollment, clear auth-fail latch and connect.
    func resetAuthAndStart() {
        authFailed = false
        closedByUs = false
        start()
    }

    // MARK: - Socket lifecycle

    private func openSocket() {
        guard !closedByUs, !authFailed else { return }
        guard let identity = DeviceIdentityStore.load() else {
            setState(.disconnected)
            return
        }

        teardownSocket(keepState: true)
        setState(state == .online || state == .reconnecting ? .reconnecting : .connecting)

        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        let sess = URLSession(configuration: config, delegate: nil, delegateQueue: nil)
        session = sess

        var request = URLRequest(url: AIOSConfig.deviceWsURL())
        // Bearer only — never query, never subprotocol-as-secret.
        request.setValue("Bearer \(identity.token)", forHTTPHeaderField: "Authorization")
        request.setValue(AIOSConfig.deviceSubprotocol, forHTTPHeaderField: "Sec-WebSocket-Protocol")

        let ws = sess.webSocketTask(with: request)
        task = ws
        ws.resume()

        receiveTask = Task { [weak self] in
            await self?.receiveLoop()
        }
        // Not online until device.hello accepted.
    }

    private func teardownSocket(keepState: Bool = false) {
        heartbeatTask?.cancel()
        heartbeatTask = nil
        receiveTask?.cancel()
        receiveTask = nil
        // Prefer graceful cancel only when we initiated stop; otherwise leave
        // closeCode readable until we snapshotted it in handleDisconnect.
        if closedByUs {
            task?.cancel(with: .goingAway, reason: nil)
        }
        task = nil
        session?.invalidateAndCancel()
        session = nil
        _ = keepState
    }

    private func receiveLoop() async {
        while !Task.isCancelled {
            guard let task else { break }
            do {
                let message = try await task.receive()
                let data: Data?
                switch message {
                case .data(let d): data = d
                case .string(let s): data = s.data(using: .utf8)
                @unknown default: data = nil
                }
                if let data {
                    await handleRaw(data)
                }
            } catch {
                await handleDisconnect(error: error)
                return
            }
        }
    }

    private func handleRaw(_ data: Data) async {
        guard let frame = try? JSONDecoder().decode(AwpFrame.self, from: data) else {
            emit(.error("BAD_FRAME"))
            return
        }
        await handleFrame(frame)
    }

    private func handleFrame(_ frame: AwpFrame) async {
        if frame.kind == "ping" {
            send(kind: "pong", reqId: frame.id)
            return
        }
        if frame.kind == "pong" {
            return
        }
        if frame.kind == "err" {
            let code = frame.payload?["code"]?.stringValue ?? ""
            let msg = frame.payload?["message"]?.stringValue ?? "device channel error"
            if code == "UNAUTHORIZED" || code == "FORBIDDEN"
                || msg.lowercased().contains("unauthorized")
                || msg.lowercased().contains("revoked")
                || msg.lowercased().contains("rotated")
            {
                await markAuthFailed(reason: msg)
            } else {
                emit(.error(msg))
            }
            return
        }
        if frame.kind == "event", let topic = frame.topic {
            switch topic {
            case "device.hello":
                let deviceId = frame.payload?["deviceId"]?.stringValue
                    ?? DeviceIdentityStore.load()?.deviceId
                    ?? ""
                let connId = frame.payload?["connId"]?.stringValue
                setState(.online)
                backoff = 1
                startHeartbeat()
                emit(.hello(deviceId: deviceId, connId: connId))
            case "device.task":
                if let taskId = frame.payload?["taskId"]?.stringValue, !taskId.isEmpty {
                    emit(.taskWake(taskId: taskId))
                }
            case "device.task.cancel":
                if let taskId = frame.payload?["taskId"]?.stringValue, !taskId.isEmpty {
                    emit(.taskCancel(taskId: taskId))
                }
            case "device.task.confirmed":
                if let taskId = frame.payload?["taskId"]?.stringValue, !taskId.isEmpty {
                    emit(.taskConfirmed(taskId: taskId))
                }
            default:
                break
            }
        }
    }

    private func startHeartbeat() {
        heartbeatTask?.cancel()
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 25_000_000_000)
                guard let self else { return }
                await self.sendHeartbeat()
            }
        }
    }

    private func sendHeartbeat() {
        guard state == .online else { return }
        send(kind: "req", topic: "device.heartbeat", payload: [:])
    }

    func sendHelloWithCapabilities(_ caps: DeviceCapabilitiesDocument) {
        guard state == .online else { return }
        guard let data = try? JSONEncoder().encode(caps),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }
        send(kind: "req", topic: "device.hello", payload: ["capabilities": obj])
    }

    func send(kind: String, topic: String? = nil, reqId: String? = nil, payload: [String: Any] = [:]) {
        var obj: [String: Any] = [
            "v": 1,
            "id": ulidLike(),
            "kind": kind,
            "ts": ISO8601DateFormatter().string(from: Date()),
        ]
        if let topic { obj["topic"] = topic }
        if let reqId { obj["reqId"] = reqId }
        if !payload.isEmpty { obj["payload"] = payload }
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let task,
              let s = String(data: data, encoding: .utf8)
        else { return }
        task.send(.string(s)) { _ in }
    }

    private func handleDisconnect(error: Error?) async {
        // Inspect closeCode **before** teardown (cancel would wipe it).
        let closeCodeRaw = task?.closeCode.rawValue ?? 0
        let closeReason = task?.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? ""

        teardownSocket(keepState: true)

        guard !closedByUs else {
            setState(.disconnected)
            return
        }
        if authFailed {
            setState(.authFailed)
            return
        }

        // Revocation / rotation / policy / auth — stop reconnect until re-enroll.
        if Self.isAuthFailureCloseCode(closeCodeRaw) {
            let reason = closeReason.isEmpty
                ? "Device WebSocket closed with auth/policy code \(closeCodeRaw)"
                : "Device WebSocket closed (\(closeCodeRaw)): \(closeReason)"
            await markAuthFailed(reason: reason)
            return
        }

        let ns = error as NSError?
        let desc = (error?.localizedDescription ?? "").lowercased()
        if desc.contains("401") || desc.contains("unauthorized") || desc.contains("revoked")
            || desc.contains("rotated") || ns?.code == 401
        {
            await markAuthFailed(reason: "WebSocket authentication failed")
            return
        }

        // Transient disconnect — bounded exponential reconnect.
        setState(.reconnecting)
        scheduleReconnect()
    }

    private func markAuthFailed(reason: String) async {
        authFailed = true
        closedByUs = true
        reconnectTask?.cancel()
        reconnectTask = nil
        teardownSocket(keepState: true)
        setState(.authFailed)
        emit(.error(reason))
    }

    private func scheduleReconnect() {
        guard !authFailed, !closedByUs else { return }
        reconnectTask?.cancel()
        let delay = backoff
        backoff = min(backoff * 2, maxBackoff)
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard let self, !Task.isCancelled else { return }
            await self.openSocket()
        }
    }

    private func setState(_ s: DeviceConnectionState) {
        state = s
        emit(.stateChanged(s))
    }

    private func emit(_ event: Event) {
        eventHandler?(event)
    }

    private func ulidLike() -> String {
        let ts = String(Int(Date().timeIntervalSince1970 * 1000), radix: 36)
        let rand = UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(16).lowercased()
        return "\(ts)\(rand)"
    }
}
