import Foundation

/// Local backend endpoints. Everything is loopback — nothing leaves the machine.
nonisolated enum AIOSConfig {
    static let httpBase = URL(string: "http://127.0.0.1:8700")!
    static func wsURL(token: String) -> URL {
        URL(string: "ws://127.0.0.1:8700/ws?token=\(token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? token)")!
    }
    static let keychainService = "com.aurion.aios-system"
}
