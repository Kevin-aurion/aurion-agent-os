import Foundation
import Observation

/// Orchestrates enrollment, device channel, capabilities, and durable task execution.
@Observable
@MainActor
final class DeviceAgentService {
    static let shared = DeviceAgentService()

    private(set) var connectionState: DeviceConnectionState = .disconnected
    private(set) var deviceId: String?
    private(set) var lastError: String?
    private(set) var lastCapabilities: DeviceCapabilitiesDocument?
    private(set) var probeNotes: [String] = []
    private(set) var taskLog: [DeviceTaskLogEntry] = []
    private(set) var isBusy = false

    private let channel = DeviceChannel()
    private var executor: DeviceTaskExecutor?
    private var started = false
    private var channelListening = false

    var isEnrolled: Bool { DeviceIdentityStore.isEnrolled }
    var isOnline: Bool { connectionState == .online }

    private init() {}

    // MARK: - Lifecycle

    func startIfEnrolled() async {
        guard DeviceIdentityStore.load() != nil else {
            deviceId = nil
            connectionState = .disconnected
            return
        }
        deviceId = DeviceIdentityStore.load()?.deviceId
        await ensureExecutorAndChannel()
    }

    private func ensureExecutorAndChannel() async {
        if executor == nil {
            executor = DeviceTaskExecutor { taskId, level, message in
                Task { @MainActor in
                    DeviceAgentService.shared.appendLog(taskId: taskId, level: level, message: message)
                }
            }
        }
        if !channelListening {
            channelListening = true
            await channel.setEventHandler { event in
                Task { @MainActor in
                    await DeviceAgentService.shared.handleChannelEvent(event)
                }
            }
        }
        await channel.start()
        started = true
    }

    func stop() async {
        await channel.stop()
        connectionState = .disconnected
    }

    // MARK: - Enrollment

    func enroll(code: String, serverURL: String?) async throws {
        if let serverURL {
            guard AIOSConfig.validatedHTTPBase(serverURL) != nil else {
                throw DeviceAgentError.invalidServerURL
            }
            AIOSConfig.serverBaseURLString = serverURL
        }
        isBusy = true
        lastError = nil
        defer { isBusy = false }

        let os = ProcessInfo.processInfo.operatingSystemVersionString
        let resp = try await DeviceAPIClient.shared.enroll(
            code: code,
            osVersion: os,
            appVersion: AIOSConfig.appVersion
        )
        try DeviceIdentityStore.store(deviceId: resp.deviceId, token: resp.token)
        deviceId = resp.deviceId
        appendLog(level: .success, message: "Enrolled device \(resp.deviceId)")
        // Never log token.

        await ensureExecutorAndChannel()
        await channel.resetAuthAndStart()
        // Report capabilities after connect (also via hello handler).
        await reportCapabilities()
    }

    func disconnectAndForget() async {
        guard let id = deviceId ?? DeviceIdentityStore.load()?.deviceId else {
            DeviceIdentityStore.clear()
            deviceId = nil
            await channel.stop()
            connectionState = .disconnected
            return
        }
        let ok = DeviceLocalConsent.confirmDisconnect(deviceId: id)
        guard ok else { return }
        await channel.stop()
        DeviceIdentityStore.clear()
        deviceId = nil
        lastCapabilities = nil
        connectionState = .disconnected
        appendLog(level: .warn, message: "Device identity cleared (local only)")
    }

    // MARK: - Capabilities

    func probeAndReport() async {
        isBusy = true
        defer { isBusy = false }
        await reportCapabilities()
    }

    func reportCapabilities() async {
        let (doc, detail) = DeviceCapabilitiesProbe.probe(includeMcp: true)
        lastCapabilities = doc
        probeNotes = detail.notes
        guard DeviceIdentityStore.isEnrolled else { return }
        do {
            _ = try await DeviceAPIClient.shared.putCapabilities(doc)
            if connectionState == .online {
                await channel.sendHelloWithCapabilities(doc)
            }
            appendLog(level: .info, message: "Capabilities reported")
        } catch let e as DeviceAPIClient.APIError where e.isAuthFailure {
            lastError = e.message
            connectionState = .authFailed
            await channel.stop()
            appendLog(level: .error, message: "Auth failed reporting capabilities")
        } catch {
            lastError = error.localizedDescription
            appendLog(level: .warn, message: "Capability report failed: \(error.localizedDescription)")
        }
    }

    @MainActor
    func requestPermissionGuidance(kind: DeviceCapabilitiesProbe.PermissionKind) {
        if kind == .screenRecording {
            _ = DeviceCapabilitiesProbe.requestScreenRecordingAccess()
        }
        DeviceCapabilitiesProbe.openPermissionSettings(kind: kind)
        // Re-probe after user returns is manual.
    }

    // MARK: - Channel events

    func handleChannelEvent(_ event: DeviceChannel.Event) async {
        switch event {
        case .stateChanged(let s):
            connectionState = s
            if s == .authFailed {
                lastError = "Device authentication failed — re-enroll required"
                appendLog(level: .error, message: lastError!)
            }
        case .hello(let deviceId, _):
            self.deviceId = deviceId
            connectionState = .online
            appendLog(level: .success, message: "device.hello accepted — online")
            await reportCapabilities()
            // Fetch open tasks after reconnect (DB is source of truth).
            await fetchOpenTasks()
        case .taskWake(let taskId):
            appendLog(taskId: taskId, level: .info, message: "WS wake")
            await processTask(taskId)
        case .taskCancel(let taskId):
            appendLog(taskId: taskId, level: .warn, message: "WS cancel")
            await executor?.markCancelled(taskId: taskId)
        case .taskConfirmed(let taskId):
            appendLog(taskId: taskId, level: .info, message: "WS confirmed")
            await executor?.notifyConfirmed(taskId: taskId)
        case .error(let msg):
            // Never include tokens; channel already avoids them.
            lastError = msg
            appendLog(level: .error, message: msg)
        }
    }

    private func fetchOpenTasks() async {
        guard let executor else { return }
        do {
            try await executor.fetchAndProcessOpenTasks()
        } catch let e as DeviceAPIClient.APIError where e.isAuthFailure {
            connectionState = .authFailed
            lastError = e.message
            await channel.stop()
        } catch {
            // logged inside executor
        }
    }

    private func processTask(_ taskId: String) async {
        guard let executor else { return }
        do {
            try await executor.handleTaskId(taskId)
        } catch let e as DeviceAPIClient.APIError where e.isAuthFailure {
            connectionState = .authFailed
            lastError = e.message
            await channel.stop()
        } catch {
            // logged
        }
    }

    // MARK: - Log

    func appendLog(taskId: String? = nil, level: DeviceTaskLogEntry.Level = .info, message: String) {
        // Redact anything that looks like a long token.
        let safe = redactForLog(message)
        taskLog.insert(DeviceTaskLogEntry(taskId: taskId, level: level, message: safe), at: 0)
        if taskLog.count > 200 {
            taskLog.removeLast(taskLog.count - 200)
        }
    }

    private func redactForLog(_ s: String) -> String {
        // Heuristic: long base64-ish tokens
        if s.count > 80, s.range(of: #"[A-Za-z0-9+/=_-]{40,}"#, options: .regularExpression) != nil {
            return String(s.prefix(40)) + "…[redacted]"
        }
        return s
    }
}

enum DeviceAgentError: Error, LocalizedError {
    case invalidServerURL
    case notEnrolled

    var errorDescription: String? {
        switch self {
        case .invalidServerURL: return "Server URL must be http:// or https:// with a host"
        case .notEnrolled: return "Device is not enrolled"
        }
    }
}
