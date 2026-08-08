import CryptoKit
import Foundation

/// Fixed LINE Desktop MCP install + runtime (manifest 1.1.2 only).
/// Never accepts URL/package/version/command overrides from the server.
///
/// **Trust boundary:** The pinned main tarball SHA-256 is the only content digest
/// we verify end-to-end. `npm install --ignore-scripts` still resolves **transitive**
/// dependencies from the registry (versions float within package.json ranges).
/// Those transitive packages are **not** covered by the main tarball digest — treat
/// them as a residual supply-chain risk, mitigated by `--ignore-scripts` (no lifecycle
/// script execution) and the fixed package pin. READY requires re-hashing the retained
/// pinned tarball on every probe, not trusting a marker file alone.
nonisolated enum LineDesktopMcpRuntime {
    static let manifest = LineDesktopMcpManifest.pinned

    enum RuntimeError: Error, LocalizedError {
        case missingNode(String)
        case missingPrereq(String)
        case downloadFailed(String)
        case shaMismatch(expected: String, actual: String)
        case installFailed(String)
        case notReady(String)
        case toolNotAllowed(String)
        case userDenied

        var errorDescription: String? {
            switch self {
            case .missingNode(let m): return m
            case .missingPrereq(let m): return m
            case .downloadFailed(let m): return "Download failed: \(m)"
            case .shaMismatch(let e, let a): return "SHA-256 mismatch (expected \(e.prefix(12))… got \(a.prefix(12))…)"
            case .installFailed(let m): return "Install failed: \(m)"
            case .notReady(let m): return m
            case .toolNotAllowed(let t): return "Tool not in allowlist: \(t)"
            case .userDenied: return "User denied MCP install"
            }
        }
    }

    // MARK: - Paths

    static var installDir: URL {
        AIOSConfig.mcpInstallRoot
            .appendingPathComponent(manifest.packageName, isDirectory: true)
            .appendingPathComponent(manifest.version, isDirectory: true)
    }

    static var packageRoot: URL {
        installDir.appendingPathComponent("package", isDirectory: true)
    }

    static var serverEntry: URL {
        packageRoot.appendingPathComponent("src/server.js")
    }

    static var shaMarker: URL {
        installDir.appendingPathComponent(".sha256")
    }

    /// Retained pinned tarball — re-hashed on every READY probe.
    static var retainedTarball: URL {
        installDir.appendingPathComponent("line-desktop-mcp-1.1.2.tgz")
    }

    // MARK: - Pure helpers (unit-testable)

    /// Exact set equality: same members, no extras, no missing. Order-insensitive.
    static func exactToolSetMatch(listed: [String], allowlist: [String]) -> Bool {
        Set(listed) == Set(allowlist)
    }

    // MARK: - Probe

    /// READY only if retained tarball re-hashes to pin, entry exists, and tools exact-match.
    static func probeReadyInstallation() -> DeviceMcpServerCapability? {
        let fm = FileManager.default
        guard fm.fileExists(atPath: serverEntry.path) else { return nil }
        guard fm.fileExists(atPath: retainedTarball.path) else { return nil }

        // Re-hash retained pinned tarball every time — do not trust .sha256 marker alone.
        guard let actual = try? sha256Hex(ofFile: retainedTarball),
              actual == manifest.sha256.lowercased()
        else { return nil }

        // Optional marker consistency check (must match pin if present).
        if let stored = try? String(contentsOf: shaMarker, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased(),
           !stored.isEmpty,
           stored != manifest.sha256.lowercased()
        {
            return nil
        }

        let toolsMarker = installDir.appendingPathComponent(".tools.json")
        var tools = manifest.toolAllowlist
        if let data = try? Data(contentsOf: toolsMarker),
           let arr = try? JSONDecoder().decode([String].self, from: data),
           !arr.isEmpty
        {
            tools = arr
        }

        // Exact set match — reject any extra or missing tool.
        guard exactToolSetMatch(listed: tools, allowlist: manifest.toolAllowlist) else {
            return nil
        }

        return DeviceMcpServerCapability(
            name: manifest.packageName,
            version: manifest.version,
            sha256: manifest.sha256,
            tools: manifest.toolAllowlist
        )
    }

    static func prerequisiteReport() -> [String] {
        var issues: [String] = []
        if resolveNode() == nil {
            issues.append("Node.js ≥ 18 not found (official line-desktop-mcp requires Node). Will not auto-install.")
        }
        let (_, detail) = DeviceCapabilitiesProbe.probe(includeMcp: false)
        if detail.lineDesktopPath == nil {
            issues.append("LINE Desktop app not found (requires LINE Desktop ≥ 9.10).")
        }
        if !detail.accessibilityTrusted {
            issues.append("Accessibility permission not granted (required for AppleScript GUI).")
        }
        let v = ProcessInfo.processInfo.operatingSystemVersion
        if v.majorVersion < 13 {
            issues.append("macOS Ventura (13)+ recommended by upstream line-desktop-mcp.")
        }
        if findInPath("cliclick") == nil {
            issues.append("cliclick not found (optional upstream helper; not auto-installed).")
        }
        return issues
    }

    // MARK: - Install

    /// Install only after local approval. Uses fixed tarball URL + SHA-256 verify.
    ///
    /// Trust: main tarball digest is verified; `npm install --ignore-scripts` still
    /// pulls transitive deps (not covered by that digest). See type-level docs above.
    static func installPinned(userApproved: Bool) async throws {
        guard userApproved else { throw RuntimeError.userDenied }
        guard let node = resolveNode() else {
            throw RuntimeError.missingNode(
                "Node.js not found in known paths. Install Node ≥ 18 manually (we do not run Homebrew)."
            )
        }
        let prereqs = prerequisiteReport().filter { !$0.contains("cliclick") }

        let fm = FileManager.default
        try fm.createDirectory(at: installDir, withIntermediateDirectories: true)

        let tarball = retainedTarball
        let url = URL(string: manifest.fixedTarballURL)!
        let (tempURL, response) = try await URLSession.shared.download(from: url)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw RuntimeError.downloadFailed("HTTP \(http.statusCode)")
        }
        if fm.fileExists(atPath: tarball.path) { try fm.removeItem(at: tarball) }
        try fm.moveItem(at: tempURL, to: tarball)

        let actual = try sha256Hex(ofFile: tarball)
        guard actual == manifest.sha256.lowercased() else {
            try? fm.removeItem(at: tarball)
            throw RuntimeError.shaMismatch(expected: manifest.sha256, actual: actual)
        }

        if fm.fileExists(atPath: packageRoot.path) {
            try fm.removeItem(at: packageRoot)
        }
        try runProcess(
            executable: "/usr/bin/tar",
            arguments: ["-xzf", tarball.path, "-C", installDir.path]
        )

        guard fm.fileExists(atPath: serverEntry.path) else {
            throw RuntimeError.installFailed("package entry src/server.js missing after extract")
        }

        // npm install production deps; --ignore-scripts blocks lifecycle scripts.
        // Transitive deps are still npm-resolved (trust boundary = main tarball digest).
        let npm = (node as NSString).deletingLastPathComponent + "/npm"
        let npmPath = fm.isExecutableFile(atPath: npm) ? npm : findInPath("npm")
        if let npmPath {
            do {
                try runProcess(
                    executable: npmPath,
                    arguments: [
                        "install",
                        "--omit=dev",
                        "--no-fund",
                        "--no-audit",
                        "--no-package-lock",
                        "--ignore-scripts",
                    ],
                    cwd: packageRoot.path,
                    timeoutSeconds: 180
                )
            } catch {
                throw RuntimeError.installFailed(
                    "npm install failed: \(error.localizedDescription). Node is present but deps incomplete."
                )
            }
        } else {
            throw RuntimeError.installFailed("npm not found next to node; cannot install dependencies")
        }

        // Verify tools via MCP tools/list — exact set, reject extras.
        var tools = manifest.toolAllowlist
        do {
            let client = DeviceMcpStdioClient()
            try await client.start(
                executable: node,
                arguments: [serverEntry.path],
                cwd: packageRoot.path
            )
            let listed = try await client.listTools(timeoutNs: 20_000_000_000)
            await client.close()
            let names = listed.map(\.name)
            if exactToolSetMatch(listed: names, allowlist: manifest.toolAllowlist) {
                tools = manifest.toolAllowlist
            } else {
                throw RuntimeError.installFailed(
                    "tools/list exact-set mismatch. Got: \(names.sorted().joined(separator: ", ")). " +
                        "Expected exactly: \(manifest.toolAllowlist.joined(separator: ", "))."
                )
            }
        } catch let e as RuntimeError {
            throw e
        } catch {
            throw RuntimeError.installFailed(
                "Could not verify tools via MCP: \(error.localizedDescription). Prerequisites: \(prereqs.joined(separator: "; "))"
            )
        }

        try manifest.sha256.write(to: shaMarker, atomically: true, encoding: .utf8)
        let toolsData = try JSONEncoder().encode(tools)
        try toolsData.write(to: installDir.appendingPathComponent(".tools.json"), options: .atomic)

        // Final READY check re-hashes tarball.
        guard probeReadyInstallation() != nil else {
            throw RuntimeError.installFailed("post-install READY probe failed (tarball re-hash or tools)")
        }
        _ = prereqs
    }

    // MARK: - Execute tool

    static func call(
        tool: String,
        args: [String: Any]?,
        timeoutNs: UInt64 = 60_000_000_000
    ) async throws -> Any {
        guard manifest.isAllowedTool(tool) else {
            throw RuntimeError.toolNotAllowed(tool)
        }
        guard probeReadyInstallation() != nil else {
            throw RuntimeError.notReady("LINE Desktop MCP not READY (install + verify first)")
        }
        guard let node = resolveNode() else {
            throw RuntimeError.missingNode("Node.js required to run line-desktop-mcp")
        }

        let client = DeviceMcpStdioClient()
        try await client.start(
            executable: node,
            arguments: [serverEntry.path],
            cwd: packageRoot.path
        )
        defer {
            Task { await client.close() }
        }
        return try await client.callTool(name: tool, args: args, timeoutNs: timeoutNs)
    }

    // MARK: - Helpers

    static func resolveNode() -> String? {
        DeviceCapabilitiesProbe.probe(includeMcp: false).1.nodePath
            ?? findInPath("node")
    }

    private static func findInPath(_ name: String) -> String? {
        let fm = FileManager.default
        if let pathEnv = ProcessInfo.processInfo.environment["PATH"] {
            for dir in pathEnv.split(separator: ":") {
                let c = "\(dir)/\(name)"
                if fm.isExecutableFile(atPath: c) { return c }
            }
        }
        for p in AIOSConfig.knownNodePaths where name == "node" {
            if fm.isExecutableFile(atPath: p) { return p }
        }
        return nil
    }

    static func sha256Hex(ofFile url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            let chunk = try handle.read(upToCount: 1024 * 1024) ?? Data()
            if chunk.isEmpty { break }
            hasher.update(data: chunk)
        }
        let digest = hasher.finalize()
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private static func runProcess(
        executable: String,
        arguments: [String],
        cwd: String? = nil,
        timeoutSeconds: TimeInterval = 60
    ) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: executable)
        p.arguments = arguments
        if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        let err = Pipe()
        p.standardOutput = Pipe()
        p.standardError = err
        try p.run()

        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while p.isRunning, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if p.isRunning {
            p.terminate()
            throw RuntimeError.installFailed("process timed out: \(executable)")
        }
        if p.terminationStatus != 0 {
            let data = err.fileHandleForReading.readDataToEndOfFile()
            let msg = String(data: data, encoding: .utf8) ?? ""
            throw RuntimeError.installFailed("\(executable) exit \(p.terminationStatus): \(msg.prefix(500))")
        }
    }
}
