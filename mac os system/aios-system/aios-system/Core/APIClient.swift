import Foundation

/// REST client for the local backend. Handles the {success,data} envelope and
/// transparent access-token refresh (mirrors the web client).
actor APIClient {
    static let shared = APIClient()

    private var access: String? = Keychain.get("access")
    private var refresh: String? = Keychain.get("refresh")

    struct APIError: Error { let code: String; let message: String }

    func setTokens(access: String, refresh: String) {
        self.access = access; self.refresh = refresh
        Keychain.set(access, for: "access"); Keychain.set(refresh, for: "refresh")
    }
    func clearTokens() {
        access = nil; refresh = nil
        Keychain.delete("access"); Keychain.delete("refresh")
    }
    var hasSession: Bool { access != nil }
    func currentAccess() -> String? { access }

    func request<T: Decodable>(_ path: String, method: String = "GET", body: Encodable? = nil, authed: Bool = true, retry: Bool = true) async throws -> T {
        var req = URLRequest(url: AIOSConfig.httpBase.appendingPathComponent(path))
        req.httpMethod = method
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        }
        if authed, let access { req.setValue("Bearer \(access)", forHTTPHeaderField: "Authorization") }

        let (data, resp) = try await URLSession.shared.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode == 401, retry, await refreshAccess() {
            return try await request(path, method: method, body: body, authed: authed, retry: false)
        }
        let env = try JSONDecoder().decode(Envelope<T>.self, from: data)
        if env.success, let d = env.data { return d }
        throw APIError(code: env.error?.code ?? "ERR", message: env.error?.message ?? "request failed")
    }

    private func refreshAccess() async -> Bool {
        guard let refresh else { return false }
        struct Body: Encodable { let refresh: String; let client = "macos" }
        do {
            let r: AuthResult = try await request("/api/auth/refresh", method: "POST", body: Body(refresh: refresh), authed: false, retry: false)
            setTokens(access: r.access, refresh: r.refresh)
            return true
        } catch { clearTokens(); return false }
    }
}

/// Type-erased Encodable so `request` can take any body.
nonisolated struct AnyEncodable: Encodable {
    private let encodeFn: (Encoder) throws -> Void
    init(_ wrapped: Encodable) { encodeFn = wrapped.encode }
    func encode(to encoder: Encoder) throws { try encodeFn(encoder) }
}
