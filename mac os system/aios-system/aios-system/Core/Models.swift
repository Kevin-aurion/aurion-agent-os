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

// MARK: - Restrictions

/// Agent capability restrictions enforced at the engine layer.
nonisolated struct Restrictions: Codable, Equatable {
    var webSearch: Bool
    var computerUse: Bool
    var sendEmail: Bool
    var cloudWrite: Bool
    var shell: Bool
    var notes: String?

    static let defaults = Restrictions(
        webSearch: true,
        computerUse: false,
        sendEmail: false,
        cloudWrite: true,
        shell: true,
        notes: nil
    )

    init(
        webSearch: Bool = true,
        computerUse: Bool = false,
        sendEmail: Bool = false,
        cloudWrite: Bool = true,
        shell: Bool = true,
        notes: String? = nil
    ) {
        self.webSearch = webSearch
        self.computerUse = computerUse
        self.sendEmail = sendEmail
        self.cloudWrite = cloudWrite
        self.shell = shell
        self.notes = notes
    }

    /// Tolerate partial JSON from the backend (missing keys use safe defaults).
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        webSearch = try c.decodeIfPresent(Bool.self, forKey: .webSearch) ?? true
        computerUse = try c.decodeIfPresent(Bool.self, forKey: .computerUse) ?? false
        sendEmail = try c.decodeIfPresent(Bool.self, forKey: .sendEmail) ?? false
        cloudWrite = try c.decodeIfPresent(Bool.self, forKey: .cloudWrite) ?? true
        shell = try c.decodeIfPresent(Bool.self, forKey: .shell) ?? true
        notes = try c.decodeIfPresent(String.self, forKey: .notes)
    }
}

// MARK: - Agent

nonisolated struct Agent: Decodable, Identifiable {
    let id: String
    let name: String
    let description: String
    let avatar: String?
    let status: String
    let skillCount: Int?
    let workflowCount: Int?
    // Optional detail / list fields (list may omit some of these)
    let slug: String?
    let department: String?
    let rolePrompt: String?
    let engineExecute: String?
    let engineVerify: String?
    let maxRounds: Int?
    let restrictions: Restrictions?
}

/// Mounted skill join row from GET /api/agents/:id.
nonisolated struct MountedSkill: Decodable, Identifiable {
    let skill: Skill
    var id: String { skill.id }
}

/// File target join row from GET /api/agents/:id.
nonisolated struct FileTarget: Decodable, Identifiable {
    let agentId: String?
    let cloudFileRefId: String?
    let purpose: String?
    let cloudFileRef: CloudFileRef?

    var id: String {
        cloudFileRef?.id ?? cloudFileRefId ?? "ft-\(purpose ?? "unknown")"
    }
}

/// Lightweight workflow ref embedded on agent detail.
nonisolated struct AgentWorkflowRef: Decodable, Identifiable {
    let id: String
    let name: String
    let enabled: Bool
}

/// Full agent payload from GET /api/agents/:id.
nonisolated struct AgentDetail: Decodable, Identifiable {
    let id: String
    let slug: String?
    let name: String
    let description: String
    let avatar: String?
    let status: String
    let department: String?
    let rolePrompt: String?
    let engineExecute: String?
    let engineVerify: String?
    let maxRounds: Int?
    let restrictions: Restrictions?
    let skills: [MountedSkill]
    let fileTargets: [FileTarget]
    let workflows: [AgentWorkflowRef]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        slug = try c.decodeIfPresent(String.self, forKey: .slug)
        name = try c.decode(String.self, forKey: .name)
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        avatar = try c.decodeIfPresent(String.self, forKey: .avatar)
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "ACTIVE"
        department = try c.decodeIfPresent(String.self, forKey: .department)
        rolePrompt = try c.decodeIfPresent(String.self, forKey: .rolePrompt)
        engineExecute = try c.decodeIfPresent(String.self, forKey: .engineExecute)
        engineVerify = try c.decodeIfPresent(String.self, forKey: .engineVerify)
        maxRounds = try c.decodeIfPresent(Int.self, forKey: .maxRounds)
        restrictions = try c.decodeIfPresent(Restrictions.self, forKey: .restrictions)
        skills = try c.decodeIfPresent([MountedSkill].self, forKey: .skills) ?? []
        fileTargets = try c.decodeIfPresent([FileTarget].self, forKey: .fileTargets) ?? []
        workflows = try c.decodeIfPresent([AgentWorkflowRef].self, forKey: .workflows) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case id, slug, name, description, avatar, status, department
        case rolePrompt, engineExecute, engineVerify, maxRounds, restrictions
        case skills, fileTargets, workflows
    }
}

// MARK: - Runs

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

// MARK: - Preflight

nonisolated struct Preflight: Decodable {
    struct Engine: Decodable { let installed: Bool; let version: String? }
    struct Engines: Decodable {
        let claude: Engine
        let codex: Engine
        let grok: Engine
    }
    struct Integrations: Decodable { let microsoft: Bool; let google: Bool; let line: Bool }
    let engines: Engines
    let integrations: Integrations
}

// MARK: - Skills

nonisolated struct Skill: Decodable, Identifiable {
    let id: String
    let slug: String?
    let name: String
    let kind: String
    let contentMd: String
    let executionEnv: String
    let reviewStatus: String
    let understanding: JSONValue?
    let version: Int?
    let origin: String?
    let generator: String?
    let confirmedBy: String?
    let confirmedAt: String?
    let createdAt: String?
    let updatedAt: String?
}

// MARK: - Workflows

nonisolated struct WorkflowSummary: Decodable, Identifiable {
    let id: String
    let agentId: String?
    let name: String
    let description: String?
    let enabled: Bool
    let trigger: JSONValue?
    let stepCount: Int?
    let createdAt: String?
    let updatedAt: String?
}

nonisolated struct WorkflowDetail: Decodable, Identifiable {
    let id: String
    let agentId: String?
    let name: String
    let description: String?
    let enabled: Bool
    let trigger: JSONValue?
    let steps: [JSONValue]?
    let createdAt: String?
    let updatedAt: String?
}

nonisolated struct WorkflowRunResult: Decodable {
    let runId: String
}

// MARK: - Org

nonisolated struct OrgUser: Decodable, Identifiable {
    let id: String
    let displayName: String
    let email: String
    let role: String?
}

nonisolated struct OrgAgent: Decodable, Identifiable {
    let id: String
    let name: String
    let description: String?
    let status: String
    let skillCount: Int?
    let workflowCount: Int?
    let department: String?
}

nonisolated struct OrgDepartment: Decodable, Identifiable {
    var id: String { name }
    let name: String
    let agents: [OrgAgent]
}

nonisolated struct OrgResponse: Decodable {
    let owner: OrgUser?
    let trainers: [OrgUser]
    let members: [OrgUser]
    let departments: [OrgDepartment]
}

// MARK: - Audit

nonisolated struct AuditEntry: Decodable, Identifiable {
    let id: String
    let userId: String?
    let action: String
    let entity: String
    let entityId: String
    let detail: JSONValue?
    let createdAt: String
}

// MARK: - Integrations / Cloud

nonisolated struct IntegrationAccount: Decodable, Identifiable {
    let id: String
    let provider: String
    let email: String
    let status: String
}

nonisolated struct IntegrationsPayload: Decodable {
    struct Configured: Decodable {
        let microsoft: Bool
        let google: Bool
        let line: Bool
    }
    let accounts: [IntegrationAccount]
    let configured: Configured
}

nonisolated struct CloudFileRef: Decodable, Identifiable {
    let id: String
    let provider: String?
    let externalId: String?
    let path: String?
    let name: String?
    let mimeType: String?
    let kind: String?
    let webUrl: String?
}

// MARK: - Dashboard

/// Nested shape for GET /api/dashboard/summary.
nonisolated struct DashboardSummary: Decodable {
    struct AgentsBlock: Decodable { let active: Int }
    struct WorkflowsBlock: Decodable { let enabled: Int }
    struct ConnectedAccount: Decodable {
        let provider: String
        let status: String
        let count: Int
    }

    let agents: AgentsBlock
    let skills: [String: Int]
    let workflows: WorkflowsBlock
    let runsToday: [String: Int]
    let connectedAccounts: [ConnectedAccount]
    let wsConnections: Int?
}

// MARK: - AWP

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
    var intValue: Int? {
        if case .number(let n) = self { return Int(n) }
        if case .string(let s) = self { return Int(s) }
        return nil
    }
    var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
    subscript(_ key: String) -> JSONValue? { if case .object(let o) = self { return o[key] }; return nil }

    /// Compact human-readable summary for UI.
    var displaySummary: String {
        switch self {
        case .string(let s): return s
        case .number(let n): return n == n.rounded() ? String(Int(n)) : String(n)
        case .bool(let b): return b ? "true" : "false"
        case .null: return "—"
        case .array(let a): return "\(a.count) 項"
        case .object(let o):
            if o.isEmpty { return "{}" }
            let keys = o.keys.sorted().prefix(4).joined(separator: ", ")
            let more = o.count > 4 ? "…" : ""
            return "{\(keys)\(more)}"
        }
    }
}
