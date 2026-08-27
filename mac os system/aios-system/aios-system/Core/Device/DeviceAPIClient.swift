import Foundation

/// Device-authenticated REST. Bearer = device token only (never user JWT, never query).
actor DeviceAPIClient {
    static let shared = DeviceAPIClient()

    struct APIError: Error, LocalizedError {
        let code: String
        let message: String
        let httpStatus: Int?
        var errorDescription: String? { message }
        var isAuthFailure: Bool {
            httpStatus == 401 || httpStatus == 403
                || code == "UNAUTHORIZED" || code == "FORBIDDEN"
        }
    }

    private let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 60
        c.timeoutIntervalForResource = 300
        return URLSession(configuration: c)
    }()

    // MARK: - Enrollment (no device token yet)

    func enroll(code: String, osVersion: String, appVersion: String) async throws -> DeviceEnrollResponse {
        let body = DeviceEnrollRequest(
            code: code.trimmingCharacters(in: .whitespacesAndNewlines),
            platform: "MACOS",
            osVersion: osVersion,
            appVersion: appVersion
        )
        return try await request(
            "/api/device/enroll",
            method: "POST",
            body: body,
            token: nil
        )
    }

    // MARK: - Authenticated

    func me() async throws -> SafeDeviceDTO {
        try await request("/api/device/me", token: requireToken())
    }

    func putCapabilities(_ caps: DeviceCapabilitiesDocument) async throws -> SafeDeviceDTO {
        try await request("/api/device/capabilities", method: "PUT", body: caps, token: requireToken())
    }

    func listOpenTasks() async throws -> [DeviceTaskDTO] {
        try await request("/api/device/tasks", token: requireToken())
    }

    func getTask(_ taskId: String) async throws -> DeviceTaskDTO {
        try await request("/api/device/tasks/\(taskId)", token: requireToken())
    }

    func ack(taskId: String, leaseMs: Int? = 60_000) async throws -> DeviceTaskDTO {
        try await request(
            "/api/device/tasks/\(taskId)/ack",
            method: "POST",
            body: DeviceAckBody(leaseMs: leaseMs),
            token: requireToken()
        )
    }

    func renewLease(taskId: String, leaseId: String, leaseMs: Int? = 60_000) async throws -> DeviceTaskDTO {
        try await request(
            "/api/device/tasks/\(taskId)/lease/renew",
            method: "POST",
            body: DeviceRenewBody(leaseId: leaseId, leaseMs: leaseMs),
            token: requireToken()
        )
    }

    func progress(
        taskId: String,
        leaseId: String,
        progress: [String: Any],
        status: String? = nil,
        confirmationArtifactId: String? = nil
    ) async throws -> DeviceTaskDTO {
        let prog = try JSONValue.fromAny(progress)
        let body = DeviceProgressBody(
            leaseId: leaseId,
            progress: prog,
            status: status,
            confirmationArtifactId: confirmationArtifactId
        )
        return try await request(
            "/api/device/tasks/\(taskId)/progress",
            method: "POST",
            body: body,
            token: requireToken()
        )
    }

    func result(
        taskId: String,
        leaseId: String,
        status: String,
        result: [String: Any]? = nil,
        error: [String: Any]? = nil
    ) async throws -> DeviceTaskDTO {
        let body = DeviceResultBody(
            leaseId: leaseId,
            status: status,
            result: try result.map { try JSONValue.fromAny($0) },
            error: try error.map { try JSONValue.fromAny($0) }
        )
        return try await request(
            "/api/device/tasks/\(taskId)/result",
            method: "POST",
            body: body,
            token: requireToken()
        )
    }

    func cancel(taskId: String, leaseId: String?, reason: String?) async throws -> DeviceTaskDTO {
        struct Body: Encodable {
            let leaseId: String?
            let reason: String?
        }
        return try await request(
            "/api/device/tasks/\(taskId)/cancel",
            method: "POST",
            body: Body(leaseId: leaseId, reason: reason),
            token: requireToken()
        )
    }

    /// Upload artifact as JSON base64 (acceptable initially per spec).
    func uploadArtifact(
        taskId: String,
        seq: Int,
        kind: String,
        mimeType: String,
        data: Data,
        clientDeclaredRedacted: Bool,
        meta: [String: Any]? = nil
    ) async throws -> DeviceArtifactDTO {
        let body = DeviceArtifactUploadBody(
            seq: seq,
            kind: kind,
            mimeType: mimeType,
            dataBase64: data.base64EncodedString(),
            clientDeclaredRedacted: clientDeclaredRedacted,
            meta: try meta.map { try JSONValue.fromAny($0) },
            ttlMs: nil
        )
        return try await request(
            "/api/device/tasks/\(taskId)/artifacts",
            method: "POST",
            body: body,
            token: requireToken()
        )
    }

    // MARK: - Internals

    private func requireToken() throws -> String {
        guard let t = DeviceIdentityStore.load()?.token, !t.isEmpty else {
            throw APIError(code: "NOT_ENROLLED", message: "Device is not enrolled", httpStatus: nil)
        }
        return t
    }

    private func request<T: Decodable>(
        _ path: String,
        method: String = "GET",
        body: Encodable? = nil,
        token: String?
    ) async throws -> T {
        var req = URLRequest(url: AIOSConfig.apiURL(path))
        req.httpMethod = method
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        }
        // Device token only via Authorization — never query string.
        if let token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let (data, resp) = try await session.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode
        if status == 401 || status == 403 {
            throw APIError(
                code: "UNAUTHORIZED",
                message: "Device authentication failed (HTTP \(status ?? 0))",
                httpStatus: status
            )
        }
        let env = try JSONDecoder().decode(Envelope<T>.self, from: data)
        if env.success, let d = env.data { return d }
        throw APIError(
            code: env.error?.code ?? "ERR",
            message: env.error?.message ?? "device request failed",
            httpStatus: status
        )
    }
}

// MARK: - JSONValue encoding helpers

extension JSONValue: Encodable {
    nonisolated func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .null: try c.encodeNil()
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    nonisolated static func fromAny(_ value: Any) throws -> JSONValue {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }

    nonisolated func asDictionary() -> [String: Any]? {
        guard case .object(let o) = self else { return nil }
        var out: [String: Any] = [:]
        for (k, v) in o {
            out[k] = v.asAny()
        }
        return out
    }

    nonisolated func asAny() -> Any {
        switch self {
        case .string(let s): return s
        case .number(let n): return n
        case .bool(let b): return b
        case .null: return NSNull()
        case .array(let a): return a.map { $0.asAny() }
        case .object(let o):
            var d: [String: Any] = [:]
            for (k, v) in o { d[k] = v.asAny() }
            return d
        }
    }
}
