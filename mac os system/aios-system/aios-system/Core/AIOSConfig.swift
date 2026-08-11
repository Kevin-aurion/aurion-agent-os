import Foundation

/// Runtime configuration for the macOS host / device agent.
/// Server base URL is user-configurable (http/https); default remains loopback.
nonisolated enum AIOSConfig {
    static let defaultServerBaseURL = "http://127.0.0.1:8700"
    static let serverBaseURLKey = "aios.serverBaseURL"

    /// User JWT Keychain service (access/refresh). Never shared with device secrets.
    static let keychainService = "com.lazyoffice.aios-system"
    /// Device identity Keychain service (deviceId + deviceToken only).
    static let deviceKeychainService = "com.lazyoffice.aios-system.device"

    static let deviceSubprotocol = "aios-device"
    static let appBundleId = "lazyoffice.aios-system"
    static let appVersion: String = {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
    }()

    // MARK: - Server URL

    static var serverBaseURLString: String {
        get {
            let raw = UserDefaults.standard.string(forKey: serverBaseURLKey)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return raw.isEmpty ? defaultServerBaseURL : raw
        }
        set {
            let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                UserDefaults.standard.removeObject(forKey: serverBaseURLKey)
            } else {
                UserDefaults.standard.set(trimmed, forKey: serverBaseURLKey)
            }
        }
    }

    /// Validated http(s) base URL. Falls back to default if stored value is invalid.
    static var httpBase: URL {
        if let url = validatedHTTPBase(serverBaseURLString) {
            return url
        }
        return URL(string: defaultServerBaseURL)!
    }

    /// Returns nil when scheme is not http/https or host is empty.
    static func validatedHTTPBase(_ raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = url.host, !host.isEmpty
        else { return nil }
        // Normalize: drop trailing slash for consistent path joining.
        if trimmed.hasSuffix("/"), trimmed.count > scheme.count + 3 {
            return URL(string: String(trimmed.dropLast()))
        }
        return url
    }

    static func wsBaseURL(from http: URL = httpBase) -> URL {
        var components = URLComponents(url: http, resolvingAgainstBaseURL: false)!
        switch components.scheme?.lowercased() {
        case "https": components.scheme = "wss"
        default: components.scheme = "ws"
        }
        components.path = ""
        components.query = nil
        components.fragment = nil
        return components.url ?? http
    }

    /// User hub AWP. Token is query-bound for the existing public `/ws` path only
    /// (device channel must never put secrets in the URL).
    static func userWsURL(token: String, baseHTTP: URL = httpBase) -> URL {
        var components = URLComponents(url: wsBaseURL(from: baseHTTP), resolvingAgainstBaseURL: false)!
        components.path = "/ws"
        components.queryItems = [
            URLQueryItem(name: "token", value: token),
        ]
        return components.url!
    }

    /// Dedicated device WebSocket path — no token in URL or query.
    static func deviceWsURL(baseHTTP: URL = httpBase) -> URL {
        var components = URLComponents(url: wsBaseURL(from: baseHTTP), resolvingAgainstBaseURL: false)!
        components.path = "/device/ws"
        components.query = nil
        return components.url!
    }

    static func httpURL(path: String, baseHTTP: URL = httpBase) -> URL {
        let p = path.hasPrefix("/") ? path : "/\(path)"
        return baseHTTP.appendingPathComponent(p.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
            // appendingPathComponent strips leading structure; rebuild carefully:
            // Prefer URL(string:relativeTo:) for absolute API paths.
            .absoluteURL
    }

    /// Join base + absolute API path (`/api/...`) without double-encoding.
    static func apiURL(_ path: String, baseHTTP: URL = httpBase) -> URL {
        let base = baseHTTP.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let p = path.hasPrefix("/") ? path : "/\(path)"
        return URL(string: base + p)!
    }

    // MARK: - Fixed host paths (never from server payload)

    /// Known Codex CLI locations + PATH lookup (performed at probe time).
    static let knownCodexCLIPaths: [String] = [
        "/usr/local/bin/codex",
        "/opt/homebrew/bin/codex",
        NSHomeDirectory() + "/.local/bin/codex",
        NSHomeDirectory() + "/.local/node/bin/codex",
        NSHomeDirectory() + "/.npm-global/bin/codex",
    ]

    static let knownNodePaths: [String] = [
        NSHomeDirectory() + "/.local/node/bin/node",
        "/usr/local/bin/node",
        "/opt/homebrew/bin/node",
        "/usr/bin/node",
    ]

    static let codexAppBundleIds = ["com.openai.codex", "com.openai.chat"]
    static let lineDesktopBundleIds = [
        "jp.naver.line.mac",
        "com.linecorp.line",
    ]

    /// Fixed Codex Computer Use bridge binary (SkyComputerUseClient).
    static var computerUseBridgePath: String {
        NSHomeDirectory()
            + "/.codex/computer-use/Codex Computer Use.app"
            + "/Contents/SharedSupport/SkyComputerUseClient.app"
            + "/Contents/MacOS/SkyComputerUseClient"
    }

    static var computerUseAppPath: String {
        NSHomeDirectory() + "/.codex/computer-use/Codex Computer Use.app"
    }

    /// Application Support root for device-local installs (MCP packages, etc.).
    static var applicationSupportRoot: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("lazyoffice.aios-system", isDirectory: true)
    }

    static var mcpInstallRoot: URL {
        applicationSupportRoot.appendingPathComponent("mcp", isDirectory: true)
    }
}
