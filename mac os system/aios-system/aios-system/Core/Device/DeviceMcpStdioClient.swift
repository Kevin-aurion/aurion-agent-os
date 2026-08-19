import Foundation

/// Minimal stdio JSON-RPC MCP client: initialize → initialized → tools/list → tools/call.
/// Process is always cleaned up on close/timeout.
///
/// Pending RPCs: continuation is registered **before** write; timeout/result/close
/// each remove+resume **exactly once** (no hang, no double-resume).
actor DeviceMcpStdioClient {
    struct ToolInfo: Sendable {
        let name: String
        let description: String?
    }

    enum ClientError: Error, LocalizedError {
        case notRunning
        case timeout(String)
        case rpc(code: Int, message: String)
        case spawnFailed(String)
        case protocolError(String)

        var errorDescription: String? {
            switch self {
            case .notRunning: return "MCP process is not running"
            case .timeout(let m): return "MCP timeout: \(m)"
            case .rpc(let c, let m): return "MCP RPC error \(c): \(m)"
            case .spawnFailed(let m): return "MCP spawn failed: \(m)"
            case .protocolError(let m): return "MCP protocol error: \(m)"
            }
        }
    }

    private var process: Process?
    private var stdinHandle: FileHandle?
    private var stdoutBuffer = Data()
    private var nextId: Int = 1
    /// Continuations for in-flight RPC ids. Presence = not yet resumed.
    private var pending: [Int: CheckedContinuation<Any, Error>] = [:]
    private var timeoutTasks: [Int: Task<Void, Never>] = [:]
    private var readSource: DispatchSourceRead?
    private let defaultTimeoutNs: UInt64 = 30_000_000_000

    /// Launch fixed executable + args (never server-supplied command).
    func start(executable: String, arguments: [String], cwd: String?) async throws {
        close()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: executable)
        p.arguments = arguments
        if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        p.environment = ProcessInfo.processInfo.environment

        let inPipe = Pipe()
        let outPipe = Pipe()
        let errPipe = Pipe()
        p.standardInput = inPipe
        p.standardOutput = outPipe
        p.standardError = errPipe

        do {
            try p.run()
        } catch {
            throw ClientError.spawnFailed(error.localizedDescription)
        }
        process = p
        stdinHandle = inPipe.fileHandleForWriting

        let outHandle = outPipe.fileHandleForReading
        let source = DispatchSource.makeReadSource(fileDescriptor: outHandle.fileDescriptor, queue: .global())
        source.setEventHandler { [weak self] in
            let chunk = outHandle.availableData
            guard !chunk.isEmpty else { return }
            Task { await self?.onStdout(chunk) }
        }
        source.resume()
        readSource = source

        // Drain stderr so the child cannot block.
        errPipe.fileHandleForReading.readabilityHandler = { handle in
            _ = handle.availableData
        }

        try await initialize()
    }

    func listTools(timeoutNs: UInt64? = nil) async throws -> [ToolInfo] {
        let result = try await request("tools/list", params: [:] as [String: Any], timeoutNs: timeoutNs)
        guard let dict = result as? [String: Any],
              let tools = dict["tools"] as? [[String: Any]]
        else {
            throw ClientError.protocolError("tools/list missing tools array")
        }
        return tools.compactMap { t in
            guard let name = t["name"] as? String else { return nil }
            return ToolInfo(name: name, description: t["description"] as? String)
        }
    }

    func callTool(name: String, args: [String: Any]?, timeoutNs: UInt64? = nil) async throws -> Any {
        var params: [String: Any] = ["name": name]
        if let args { params["arguments"] = args }
        return try await request("tools/call", params: params, timeoutNs: timeoutNs)
    }

    func close() {
        // Resume every pending exactly once, then clear.
        let ids = Array(pending.keys)
        for id in ids {
            resumePending(id: id, with: .failure(ClientError.notRunning))
        }
        // Safety: if any linger, drop them (should be empty).
        pending.removeAll()
        for (_, t) in timeoutTasks { t.cancel() }
        timeoutTasks.removeAll()

        readSource?.cancel()
        readSource = nil
        try? stdinHandle?.close()
        stdinHandle = nil
        if let process, process.isRunning {
            process.terminate()
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
                if process.isRunning { process.interrupt() }
            }
        }
        process = nil
        stdoutBuffer = Data()
    }

    // MARK: - Protocol

    private func initialize() async throws {
        let params: [String: Any] = [
            "protocolVersion": "2024-11-05",
            "capabilities": [:] as [String: Any],
            "clientInfo": [
                "name": "aios-macos-device-agent",
                "version": AIOSConfig.appVersion,
            ],
        ]
        _ = try await request("initialize", params: params, timeoutNs: 15_000_000_000)
        try sendNotification("notifications/initialized", params: [:] as [String: Any])
    }

    /// Register pending continuation **before** write; timeout removes+resumes once.
    private func request(_ method: String, params: [String: Any], timeoutNs: UInt64?) async throws -> Any {
        guard process?.isRunning == true, stdinHandle != nil else {
            throw ClientError.notRunning
        }
        let id = nextId
        nextId += 1
        let msg: [String: Any] = [
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        ]
        let timeout = timeoutNs ?? defaultTimeoutNs
        let methodName = method

        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Any, Error>) in
            // 1) Atomic register first — no response-before-register race.
            self.pending[id] = cont

            // 2) Actor timeout handler: remove+resume exactly once.
            let t = Task { [weak self] in
                try? await Task.sleep(nanoseconds: timeout)
                await self?.resumePending(id: id, with: .failure(ClientError.timeout(methodName)))
            }
            self.timeoutTasks[id] = t

            // 3) Write after registration.
            do {
                try self.write(msg)
            } catch {
                self.resumePending(id: id, with: .failure(error))
            }
        }
    }

    /// Remove from pending (if present) and resume exactly once. Safe for concurrent
    /// timeout / result / close.
    private func resumePending(id: Int, with result: Result<Any, Error>) {
        guard let cont = pending.removeValue(forKey: id) else {
            // Already resumed — no double-resume.
            return
        }
        if let t = timeoutTasks.removeValue(forKey: id) {
            t.cancel()
        }
        switch result {
        case .success(let value):
            cont.resume(returning: value)
        case .failure(let error):
            cont.resume(throwing: error)
        }
    }

    private func sendNotification(_ method: String, params: [String: Any]) throws {
        let msg: [String: Any] = [
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        ]
        try write(msg)
    }

    private func write(_ obj: [String: Any]) throws {
        guard let stdinHandle else { throw ClientError.notRunning }
        var data = try JSONSerialization.data(withJSONObject: obj)
        data.append(contentsOf: [0x0A]) // newline-delimited JSON-RPC
        try stdinHandle.write(contentsOf: data)
    }

    private func onStdout(_ chunk: Data) {
        stdoutBuffer.append(chunk)
        while let range = stdoutBuffer.range(of: Data([0x0A])) {
            let line = stdoutBuffer.subdata(in: stdoutBuffer.startIndex..<range.lowerBound)
            stdoutBuffer.removeSubrange(stdoutBuffer.startIndex...range.lowerBound)
            guard !line.isEmpty,
                  let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any]
            else { continue }
            handleMessage(obj)
        }
    }

    private func handleMessage(_ obj: [String: Any]) {
        // JSON-RPC id may arrive as Int or NSNumber.
        let id: Int? = {
            if let i = obj["id"] as? Int { return i }
            if let n = obj["id"] as? NSNumber { return n.intValue }
            return nil
        }()
        guard let id else { return } // notifications

        if let err = obj["error"] as? [String: Any] {
            let code = (err["code"] as? Int) ?? (err["code"] as? NSNumber)?.intValue ?? -1
            let message = err["message"] as? String ?? "error"
            resumePending(id: id, with: .failure(ClientError.rpc(code: code, message: message)))
            return
        }
        if let result = obj["result"] {
            resumePending(id: id, with: .success(result))
        } else {
            resumePending(id: id, with: .success(NSNull()))
        }
    }

    deinit {
        process?.terminate()
    }
}
