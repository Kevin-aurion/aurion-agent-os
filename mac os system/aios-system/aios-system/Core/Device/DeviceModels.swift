import Foundation

// MARK: - Capabilities (matches backend DeviceCapabilitiesSchema)

nonisolated struct DeviceCapabilitiesDocument: Codable, Equatable, Sendable {
    var platform: String
    var osVersion: String
    var appVersion: String
    var features: DeviceFeatureFlags
    var mcpServers: [DeviceMcpServerCapability]
    var updatedAt: String?

    struct DeviceFeatureFlags: Codable, Equatable, Sendable {
        var computerUse: Bool
        var screenRecording: Bool
        var accessibility: Bool
        var screenshot: Bool
        var codexApp: Bool
        var codexCli: Bool
        var lineDesktop: Bool
    }
}

nonisolated struct DeviceMcpServerCapability: Codable, Equatable, Sendable {
    var name: String
    var version: String
    var sha256: String?
    var tools: [String]
}

// MARK: - Enrollment / device self

nonisolated struct DeviceEnrollRequest: Encodable, Sendable {
    let code: String
    let platform: String
    let osVersion: String
    let appVersion: String
}

nonisolated struct DeviceEnrollResponse: Decodable, Sendable {
    let deviceId: String
    let token: String
    let device: SafeDeviceDTO?
}

nonisolated struct SafeDeviceDTO: Decodable, Sendable, Identifiable {
    let id: String
    let name: String?
    let platform: String?
    let status: String?
    let osVersion: String?
    let appVersion: String?
    let online: Bool?
}

// MARK: - Tasks

nonisolated struct DeviceTaskDTO: Decodable, Identifiable, Sendable {
    let id: String
    let deviceId: String
    let agentId: String?
    let runId: String?
    let stepKey: String?
    let kind: String
    let status: String
    let payload: JSONValue?
    let result: JSONValue?
    let error: JSONValue?
    let leaseId: String?
    let leaseExpiresAt: String?
    let deadlineAt: String?
    let confirmationRequired: Bool?
    let confirmationArtifactId: String?
    let confirmedAt: String?
    let terminalAt: String?
    let createdAt: String?
    let updatedAt: String?

    var isTerminal: Bool {
        ["SUCCEEDED", "FAILED", "TIMEOUT", "CANCELLED"].contains(status)
    }

    var isOpen: Bool {
        ["PENDING", "DISPATCHED", "ACKED", "RUNNING", "AWAITING_CONFIRM"].contains(status)
    }
}

nonisolated struct DeviceAckBody: Encodable, Sendable {
    let leaseMs: Int?
}

nonisolated struct DeviceRenewBody: Encodable, Sendable {
    let leaseId: String
    let leaseMs: Int?
}

nonisolated struct DeviceProgressBody: Encodable, Sendable {
    let leaseId: String
    let progress: JSONValue
    let status: String?
    let confirmationArtifactId: String?
}

nonisolated struct DeviceResultBody: Encodable, Sendable {
    let leaseId: String
    let status: String
    let result: JSONValue?
    let error: JSONValue?
}

nonisolated struct DeviceArtifactUploadBody: Encodable, Sendable {
    let seq: Int
    let kind: String
    let mimeType: String
    let dataBase64: String
    let clientDeclaredRedacted: Bool
    let meta: JSONValue?
    let ttlMs: Int?
}

nonisolated struct DeviceArtifactDTO: Decodable, Sendable, Identifiable {
    let id: String
    let taskId: String?
    let deviceId: String?
    let seq: Int?
    let kind: String?
    let sha256: String?
    let sizeBytes: Int?
    let mimeType: String?
    let redacted: Bool?
    let clientDeclaredRedacted: Bool?
}

// MARK: - Connection state

nonisolated enum DeviceConnectionState: String, Sendable, Equatable {
    case disconnected
    case connecting
    case online
    /// Auth/revocation failed — do not reconnect until re-enrollment.
    case authFailed
    case reconnecting
}

// MARK: - Local task log (no secrets)

nonisolated struct DeviceTaskLogEntry: Identifiable, Equatable, Sendable {
    let id: UUID
    let at: Date
    let taskId: String?
    let level: Level
    let message: String

    enum Level: String, Sendable {
        case info, warn, error, success
    }

    init(taskId: String? = nil, level: Level = .info, message: String) {
        self.id = UUID()
        self.at = Date()
        self.taskId = taskId
        self.level = level
        self.message = message
    }
}
