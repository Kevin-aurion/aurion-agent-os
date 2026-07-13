import Foundation

// API envelope
nonisolated struct Envelope<T: Decodable>: Decodable {
    let success: Bool
    let data: T?
    let error: APIErrorBody?
}
nonisolated struct APIErrorBody: Decodable { let code: String; let message: String }

nonisolated struct AIOSUser: Decodable, Identifiable { let id: String; let email: String; let displayName: String; let role: String }
nonisolated struct AuthResult: Decodable { let access: String; let refresh: String; let user: AIOSUser }
nonisolated struct AuthStatus: Decodable { let initialized: Bool }

nonisolated struct Agent: Decodable, Identifiable {
    let id: String; let name: String; let description: String
    let avatar: String?; let status: String
    let skillCount: Int?; let workflowCount: Int?
}

nonisolated struct RunSummary: Decodable, Identifiable {
    let id: String; let agentId: String; let workflowId: String?
    let status: String; let triggeredBy: String
    let startedAt: String; let finishedAt: String?
}

nonisolated struct RunStepRow: Decodable, Identifiable {
    let id: String; let stepKey: String; let round: Int
    let status: String; let output: String?; let verdict: String?; let approved: Bool?
}

nonisolated struct ConversationRow: Decodable, Identifiable { let id: String; let title: String? }
nonisolated struct MessageRow: Decodable, Identifiable { let id: String; let role: String; let content: String; let runId: String?; let createdAt: String }

nonisolated struct Preflight: Decodable {
    struct Engine: Decodable { let installed: Bool; let version: String? }
    struct Engines: Decodable { let claude: Engine; let codex: Engine }
    struct Integrations: Decodable { let microsoft: Bool; let google: Bool; let line: Bool }
    let engines: Engines; let integrations: Integrations
}

// AWP/1 wire frame (decode-only view; payload kept as raw JSON).
nonisolated struct AwpFrame: Decodable {
    let v: Int; let id: String; let kind: String
    let topic: String?; let reqId: String?; let seq: Int?; let ts: String?
    let payload: JSONValue?
}

/// Lightweight JSON value for dynamic payloads.
nonisolated enum JSONValue: Decodable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else if let o = try? c.decode([String: JSONValue].self) { self = .object(o) }
        else { self = .null }
    }
    var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    subscript(_ key: String) -> JSONValue? { if case .object(let o) = self { return o[key] }; return nil }
}
