import Foundation

/// Device identity (deviceId + bearer token) — Keychain only, never UserDefaults/logs.
nonisolated enum DeviceIdentityStore {
    static let deviceIdKey = "deviceId"
    static let deviceTokenKey = "deviceToken"

    struct Identity: Equatable, Sendable {
        let deviceId: String
        let token: String
    }

    static var isEnrolled: Bool { load() != nil }

    static func load() -> Identity? {
        guard let id = Keychain.getDevice(deviceIdKey)?.trimmingCharacters(in: .whitespacesAndNewlines),
              let token = Keychain.getDevice(deviceTokenKey)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !id.isEmpty, !token.isEmpty
        else { return nil }
        return Identity(deviceId: id, token: token)
    }

    /// Store enrollment result. Token is returned once from the server.
    static func store(deviceId: String, token: String) throws {
        let id = deviceId.trimmingCharacters(in: .whitespacesAndNewlines)
        let t = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty, !t.isEmpty else {
            throw DeviceIdentityError.invalidCredentials
        }
        Keychain.setDevice(id, for: deviceIdKey)
        Keychain.setDevice(t, for: deviceTokenKey)
    }

    static func clear() {
        Keychain.clearDeviceIdentity()
    }

    /// Safe display only — never log the full token.
    static func safePrefix(of token: String, length: Int = 8) -> String {
        String(token.prefix(length))
    }
}

nonisolated enum DeviceIdentityError: Error, LocalizedError {
    case invalidCredentials
    case notEnrolled

    var errorDescription: String? {
        switch self {
        case .invalidCredentials: return "Invalid device credentials"
        case .notEnrolled: return "Device is not enrolled"
        }
    }
}
