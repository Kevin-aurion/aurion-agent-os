import Foundation
import Security

/// Minimal Keychain wrapper. User JWT and device credentials use **distinct**
/// services; device tokens never go to UserDefaults, logs, or query strings.
nonisolated enum Keychain {
    // MARK: - User JWT (existing service)

    static func set(_ value: String, for key: String) {
        set(value, account: key, service: AIOSConfig.keychainService)
    }

    static func get(_ key: String) -> String? {
        get(account: key, service: AIOSConfig.keychainService)
    }

    static func delete(_ key: String) {
        delete(account: key, service: AIOSConfig.keychainService)
    }

    // MARK: - Device identity (separate service)

    static func setDevice(_ value: String, for key: String) {
        set(value, account: key, service: AIOSConfig.deviceKeychainService)
    }

    static func getDevice(_ key: String) -> String? {
        get(account: key, service: AIOSConfig.deviceKeychainService)
    }

    static func deleteDevice(_ key: String) {
        delete(account: key, service: AIOSConfig.deviceKeychainService)
    }

    static func clearDeviceIdentity() {
        deleteDevice(DeviceIdentityStore.deviceIdKey)
        deleteDevice(DeviceIdentityStore.deviceTokenKey)
    }

    // MARK: - Core

    private static func set(_ value: String, account: String, service: String) {
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }

    private static func get(account: String, service: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data,
              let s = String(data: data, encoding: .utf8)
        else { return nil }
        return s
    }

    private static func delete(account: String, service: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
