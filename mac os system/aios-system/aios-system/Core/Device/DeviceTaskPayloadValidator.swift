import Foundation

/// Pure, unit-testable allowlist for DeviceTask payloads (mirrors backend
/// `devicetaskpayload.ts`). Rejects shell/command/path fields fail-closed.
nonisolated enum DeviceTaskKindName: String, CaseIterable, Sendable {
    case computerControl = "COMPUTER_CONTROL"
    case mcpTool = "MCP_TOOL"
    case lineDesktop = "LINE_DESKTOP"
    case screenshot = "SCREENSHOT"
    case capabilityProbe = "CAPABILITY_PROBE"
    case mcpInstall = "MCP_INSTALL"
}

nonisolated enum DeviceTaskPayloadValidator {
    static let forbiddenKeys: Set<String> = [
        "command", "shell", "executable", "exec", "bash", "cmd",
        "powershell", "script", "argv", "cwd", "env",
    ]

    static let bannedTopLevel: Set<String> = [
        "url", "host", "port", "baseUrl", "endpoint", "command", "cwd",
    ]

    /// Fixed LINE Desktop MCP manifest — never client-overridable.
    static let lineDesktopManifest = LineDesktopMcpManifest.pinned

    struct ValidationError: Error, LocalizedError, Equatable {
        let message: String
        var errorDescription: String? { message }
    }

    // MARK: - Public

    static func parseKind(_ raw: String) -> DeviceTaskKindName? {
        DeviceTaskKindName(rawValue: raw)
    }

    /// Validate raw JSON object for a known kind. Returns a sanitized dictionary.
    static func validate(kind: DeviceTaskKindName, payload: [String: Any]?) throws -> [String: Any] {
        let raw = payload ?? [:]
        if raw.isEmpty {
            if kind == .capabilityProbe || kind == .screenshot {
                return [:]
            }
            throw ValidationError(message: "payload required for kind \(kind.rawValue)")
        }

        try assertNoForbiddenKeys(raw)
        for banned in bannedTopLevel where raw.keys.contains(banned) {
            throw ValidationError(message: "Forbidden payload field: \(banned)")
        }

        switch kind {
        case .computerControl:
            return try validateComputerControl(raw)
        case .mcpTool:
            return try validateMcpTool(raw)
        case .lineDesktop:
            return try validateLineDesktop(raw)
        case .screenshot:
            return try validateScreenshot(raw)
        case .capabilityProbe:
            return try validateCapabilityProbe(raw)
        case .mcpInstall:
            return try validateMcpInstall(raw)
        }
    }

    /// Decode JSON Data → validate.
    static func validateJSON(kindRaw: String, data: Data?) throws -> (DeviceTaskKindName, [String: Any]) {
        guard let kind = parseKind(kindRaw) else {
            throw ValidationError(message: "Unsupported task kind: \(kindRaw)")
        }
        guard let data, !data.isEmpty else {
            let empty = try validate(kind: kind, payload: nil)
            return (kind, empty)
        }
        let obj = try JSONSerialization.jsonObject(with: data)
        guard let dict = obj as? [String: Any] else {
            throw ValidationError(message: "payload must be an object")
        }
        return (kind, try validate(kind: kind, payload: dict))
    }

    // MARK: - Kind validators

    private static func validateComputerControl(_ raw: [String: Any]) throws -> [String: Any] {
        try assertOnlyKeys(raw, allowed: [
            "skillId", "skillVersionId", "instructions", "app", "window", "checkpoint",
        ])
        if let s = raw["skillId"] { try assertString(s, field: "skillId", max: 128) }
        if let s = raw["skillVersionId"] { try assertString(s, field: "skillVersionId", max: 128) }
        if let s = raw["instructions"] { try assertString(s, field: "instructions", max: 20_000) }
        if let s = raw["app"] { try assertString(s, field: "app", max: 256) }
        if let s = raw["window"] { try assertString(s, field: "window", max: 512) }
        if let cp = raw["checkpoint"] {
            guard let cpd = cp as? [String: Any] else {
                throw ValidationError(message: "checkpoint must be an object")
            }
            try assertOnlyKeys(cpd, allowed: ["requireScreenshot", "label"])
            if let b = cpd["requireScreenshot"], !(b is Bool) {
                throw ValidationError(message: "checkpoint.requireScreenshot must be boolean")
            }
            if let lab = cpd["label"] { try assertString(lab, field: "checkpoint.label", max: 256) }
        }
        let has =
            stringNonEmpty(raw["skillId"])
            || stringNonEmpty(raw["skillVersionId"])
            || stringNonEmpty(raw["instructions"])
            || stringNonEmpty(raw["app"])
        guard has else {
            throw ValidationError(
                message: "COMPUTER_CONTROL requires skillId, skillVersionId, instructions, or app"
            )
        }
        return raw
    }

    private static func validateMcpTool(_ raw: [String: Any]) throws -> [String: Any] {
        try assertOnlyKeys(raw, allowed: ["serverId", "tool", "args"])
        try assertString(raw["serverId"], field: "serverId", max: 128, required: true)
        try assertString(raw["tool"], field: "tool", max: 128, required: true)
        if let args = raw["args"] {
            guard let ad = args as? [String: Any] else {
                throw ValidationError(message: "args must be an object")
            }
            try assertNoForbiddenKeys(ad)
        }
        return raw
    }

    private static func validateLineDesktop(_ raw: [String: Any]) throws -> [String: Any] {
        try assertOnlyKeys(raw, allowed: ["operation", "tool", "args"])
        guard let op = raw["operation"] as? String, op == "read" || op == "send" else {
            throw ValidationError(message: "LINE_DESKTOP.operation must be read|send")
        }
        if let tool = raw["tool"] {
            let t = try assertString(tool, field: "tool", max: 128)
            if !lineDesktopManifest.toolAllowlist.contains(t) {
                throw ValidationError(message: "LINE tool not in allowlist: \(t)")
            }
        }
        if let args = raw["args"] {
            guard let ad = args as? [String: Any] else {
                throw ValidationError(message: "args must be an object")
            }
            try assertNoForbiddenKeys(ad)
        }
        return raw
    }

    private static func validateScreenshot(_ raw: [String: Any]) throws -> [String: Any] {
        try assertOnlyKeys(raw, allowed: ["app", "window", "region"])
        if let s = raw["app"] { try assertString(s, field: "app", max: 256) }
        if let s = raw["window"] { try assertString(s, field: "window", max: 512) }
        if let region = raw["region"] {
            guard let r = region as? [String: Any] else {
                throw ValidationError(message: "region must be an object")
            }
            try assertOnlyKeys(r, allowed: ["x", "y", "width", "height"])
            for k in ["x", "y", "width", "height"] {
                guard let n = numberValue(r[k]) else {
                    throw ValidationError(message: "region.\(k) must be a number")
                }
                if k == "width" || k == "height" {
                    if n <= 0 { throw ValidationError(message: "region.\(k) must be positive") }
                } else if n < 0 {
                    throw ValidationError(message: "region.\(k) must be non-negative")
                }
            }
        }
        return raw
    }

    private static func validateCapabilityProbe(_ raw: [String: Any]) throws -> [String: Any] {
        try assertOnlyKeys(raw, allowed: ["features"])
        if let features = raw["features"] {
            guard let arr = features as? [Any], arr.count <= 32 else {
                throw ValidationError(message: "features must be an array (max 32)")
            }
            for (i, f) in arr.enumerated() {
                _ = try assertString(f, field: "features[\(i)]", max: 64)
            }
        }
        return raw
    }

    private static func validateMcpInstall(_ raw: [String: Any]) throws -> [String: Any] {
        // Only exact pinned LINE manifest is accepted — no URL/package/version overrides.
        let m = lineDesktopManifest
        try assertOnlyKeys(raw, allowed: [
            "mcpKey", "packageName", "version", "sha256", "toolAllowlist", "transport",
        ])
        guard raw["mcpKey"] as? String == m.mcpKey else {
            throw ValidationError(message: "MCP_INSTALL mcpKey must be \(m.mcpKey)")
        }
        guard raw["packageName"] as? String == m.packageName else {
            throw ValidationError(message: "MCP_INSTALL packageName must be \(m.packageName)")
        }
        guard raw["version"] as? String == m.version else {
            throw ValidationError(message: "MCP_INSTALL version must be \(m.version)")
        }
        guard (raw["sha256"] as? String)?.lowercased() == m.sha256.lowercased() else {
            throw ValidationError(message: "MCP_INSTALL sha256 mismatch")
        }
        guard raw["transport"] as? String == m.transport else {
            throw ValidationError(message: "MCP_INSTALL transport must be device-local-stdio")
        }
        guard let tools = raw["toolAllowlist"] as? [Any], !tools.isEmpty, tools.count <= 32 else {
            throw ValidationError(message: "toolAllowlist required")
        }
        var parsed: [String] = []
        for (i, t) in tools.enumerated() {
            let s = try assertString(t, field: "toolAllowlist[\(i)]", max: 128)
            parsed.append(s)
        }
        let allow = Set(m.toolAllowlist)
        guard parsed.allSatisfy({ allow.contains($0) }),
              m.toolAllowlist.allSatisfy({ parsed.contains($0) })
        else {
            throw ValidationError(message: "toolAllowlist must exactly match pinned LINE tools")
        }
        return [
            "mcpKey": m.mcpKey,
            "packageName": m.packageName,
            "version": m.version,
            "sha256": m.sha256,
            "toolAllowlist": m.toolAllowlist,
            "transport": m.transport,
        ]
    }

    // MARK: - Helpers

    static func assertNoForbiddenKeys(_ value: Any, path: String = "") throws {
        if let arr = value as? [Any] {
            for (i, v) in arr.enumerated() {
                try assertNoForbiddenKeys(v, path: "\(path)[\(i)]")
            }
            return
        }
        guard let obj = value as? [String: Any] else { return }
        for (k, v) in obj {
            let lower = k.lowercased()
            if forbiddenKeys.contains(lower) {
                let p = path.isEmpty ? k : "\(path).\(k)"
                throw ValidationError(message: "Forbidden payload field: \(p)")
            }
            if lower == "path" || lower == "filepath" || lower == "filename" {
                let p = path.isEmpty ? k : "\(path).\(k)"
                throw ValidationError(message: "Forbidden payload field: \(p)")
            }
            try assertNoForbiddenKeys(v, path: path.isEmpty ? k : "\(path).\(k)")
        }
    }

    private static func assertOnlyKeys(_ obj: [String: Any], allowed: Set<String>) throws {
        for k in obj.keys where !allowed.contains(k) {
            throw ValidationError(message: "Unknown payload field: \(k)")
        }
    }

    @discardableResult
    private static func assertString(
        _ value: Any?,
        field: String,
        max: Int,
        required: Bool = false
    ) throws -> String {
        guard let value else {
            if required { throw ValidationError(message: "\(field) required") }
            return ""
        }
        guard let s = value as? String else {
            throw ValidationError(message: "\(field) must be a string")
        }
        if s.isEmpty && required {
            throw ValidationError(message: "\(field) required")
        }
        if s.count > max {
            throw ValidationError(message: "\(field) exceeds max length \(max)")
        }
        return s
    }

    private static func stringNonEmpty(_ value: Any?) -> Bool {
        guard let s = value as? String else { return false }
        return !s.isEmpty
    }

    private static func numberValue(_ value: Any?) -> Double? {
        if let i = value as? Int { return Double(i) }
        if let d = value as? Double { return d }
        if let n = value as? NSNumber { return n.doubleValue }
        return nil
    }
}

/// Pinned LINE Desktop MCP constants (must match backend `LINE_DESKTOP_MANIFEST`).
nonisolated struct LineDesktopMcpManifest: Equatable, Sendable {
    let mcpKey: String
    let packageName: String
    let version: String
    let sha256: String
    let transport: String
    let toolAllowlist: [String]
    let readTools: [String]
    let sendTools: [String]
    /// Fixed npm tarball URL for the pinned version only (not overridable by server).
    let fixedTarballURL: String

    static let pinned = LineDesktopMcpManifest(
        mcpKey: "line-desktop-mcp",
        packageName: "line-desktop-mcp",
        version: "1.1.2",
        sha256: "6f8dff26fe5e13ad886dd04e8e6d9bc788c709e92f85e46b25523c402f20bc7a",
        transport: "device-local-stdio",
        toolAllowlist: [
            "get_line_chatroom_history_default",
            "get_line_chatroom_history_long",
            "get_line_chatroom_history_short",
            "send_message_manual",
            "send_message_auto",
        ],
        readTools: [
            "get_line_chatroom_history_default",
            "get_line_chatroom_history_long",
            "get_line_chatroom_history_short",
        ],
        sendTools: [
            "send_message_manual",
            "send_message_auto",
        ],
        fixedTarballURL: "https://registry.npmjs.org/line-desktop-mcp/-/line-desktop-mcp-1.1.2.tgz"
    )

    func isSendTool(_ tool: String) -> Bool { sendTools.contains(tool) }
    func isReadTool(_ tool: String) -> Bool { readTools.contains(tool) }
    func isAllowedTool(_ tool: String) -> Bool { toolAllowlist.contains(tool) }
}
