import AppKit
import Foundation

/// General Computer Use via **fixed** local Codex / Computer Use bridge paths only.
/// Never executes server-supplied command/argv/env. Instructions are data.
nonisolated enum ComputerUseBridge {
    enum BridgeError: Error, LocalizedError {
        case missingBridge(String)
        case userDenied
        case timeout
        case failed(String)
        case cannotProveCompletion(String)

        var errorDescription: String? {
            switch self {
            case .missingBridge(let m): return m
            case .userDenied: return "User denied Computer Use"
            case .timeout: return "Computer Use bridge timed out without proven completion"
            case .failed(let m): return m
            case .cannotProveCompletion(let m): return m
            }
        }
    }

    struct ExecutionOutcome: Sendable {
        let proven: Bool
        let summary: String
        /// JSON-serializable detail map (strings only for Sendable safety).
        let details: [String: String]
    }

    /// Fixed invocation template: try Computer Use MCP list_tools + optional
    /// codex CLI `exec` with instructions as stdin data (not argv shell).
    static func execute(
        instructions: String?,
        app: String?,
        skillId: String?,
        timeoutSeconds: TimeInterval = 120
    ) async throws -> ExecutionOutcome {
        let bridge = AIOSConfig.computerUseBridgePath
        let bridgeOK = FileManager.default.isExecutableFile(atPath: bridge)
        let (_, detail) = DeviceCapabilitiesProbe.probe(includeMcp: false)

        guard bridgeOK || detail.codexCLIPath != nil || detail.codexAppPath != nil else {
            throw BridgeError.missingBridge(
                "No fixed Codex App, CLI, or Computer Use bridge found. Cannot execute."
            )
        }

        var details: [String: String] = [
            "bridgePath": bridgeOK ? bridge : "",
            "codexCli": detail.codexCLIPath ?? "",
            "codexApp": detail.codexAppPath ?? "",
            "appHint": app ?? "",
            "skillId": skillId ?? "",
        ]

        // Phase 1: prove Computer Use MCP bridge can initialize and list tools.
        if bridgeOK {
            let client = DeviceMcpStdioClient()
            do {
                try await client.start(
                    executable: bridge,
                    arguments: ["mcp"],
                    cwd: (bridge as NSString).deletingLastPathComponent
                )
                let tools = try await client.listTools(timeoutNs: 20_000_000_000)
                await client.close()
                details["mcpTools"] = tools.map(\.name).joined(separator: ",")
                details["bridgeHandshake"] = "ok"
            } catch {
                await client.close()
                details["bridgeHandshake"] = "failed"
                details["bridgeError"] = error.localizedDescription
                // ADR 0005: tools/call often times out; handshake failure is honest FAIL path.
                throw BridgeError.cannotProveCompletion(
                    "Computer Use bridge handshake failed: \(error.localizedDescription). " +
                        "ADR 0005: live tools/call may require Codex/ChatGPT App authorization context."
                )
            }
        }

        // Phase 2: if we only have instructions text, attempt fixed codex CLI exec
        // with prompt on stdin (data), fixed argv template only.
        let prompt = buildPrompt(instructions: instructions, app: app, skillId: skillId)
        if let cli = detail.codexCLIPath, !prompt.isEmpty {
            do {
                let output = try await runCodexExec(cliPath: cli, prompt: prompt, timeoutSeconds: timeoutSeconds)
                details["codexExec"] = "completed"
                details["codexOutputBytes"] = String(output.utf8.count)
                // We cannot claim UI automation success from text alone without a verifier.
                // Treat non-zero empty as incomplete unless output is non-empty.
                if output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    throw BridgeError.cannotProveCompletion(
                        "codex exec produced empty output; UI completion not proven"
                    )
                }
                return ExecutionOutcome(
                    proven: false,
                    summary: "codex exec finished but Computer Use GUI completion is not attested by this agent",
                    details: details
                )
            } catch let e as BridgeError {
                throw e
            } catch {
                details["codexExec"] = "failed"
                details["codexError"] = error.localizedDescription
            }
        }

        // Phase 3: open Codex App only — NEVER report success for mere launch.
        if let appPath = detail.codexAppPath {
            let url = URL(fileURLWithPath: appPath)
            let cfg = NSWorkspace.OpenConfiguration()
            do {
                try await NSWorkspace.shared.openApplication(at: url, configuration: cfg)
                details["codexAppLaunched"] = "true"
            } catch {
                details["codexAppLaunched"] = "false"
                details["codexAppError"] = error.localizedDescription
            }
        }

        throw BridgeError.cannotProveCompletion(
            "Cannot prove Computer Use task completion. " +
                "Bridge handshake may have succeeded, but automated tools/call completion is not verified " +
                "(see ADR 0005). Never reporting launched-app as success. Details keys: \(details.keys.sorted())"
        )
    }

    private static func buildPrompt(instructions: String?, app: String?, skillId: String?) -> String {
        var parts: [String] = []
        parts.append("You are executing a device Computer Use task for AIOS.")
        if let app, !app.isEmpty { parts.append("Target app: \(app)") }
        if let skillId, !skillId.isEmpty { parts.append("Skill id: \(skillId)") }
        if let instructions, !instructions.isEmpty {
            parts.append("Instructions:\n\(instructions)")
        }
        return parts.joined(separator: "\n\n")
    }

    /// Fixed template: `codex exec -` with prompt on stdin. No shell, no extra env from server.
    private static func runCodexExec(cliPath: String, prompt: String, timeoutSeconds: TimeInterval) async throws -> String {
        try await withCheckedThrowingContinuation { cont in
            DispatchQueue.global(qos: .userInitiated).async {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: cliPath)
                // Fixed argv only — prompt is data on stdin.
                p.arguments = ["exec", "-"]
                let inPipe = Pipe()
                let outPipe = Pipe()
                let errPipe = Pipe()
                p.standardInput = inPipe
                p.standardOutput = outPipe
                p.standardError = errPipe
                do {
                    try p.run()
                    if let data = prompt.data(using: .utf8) {
                        try inPipe.fileHandleForWriting.write(contentsOf: data)
                    }
                    try inPipe.fileHandleForWriting.close()
                } catch {
                    cont.resume(throwing: BridgeError.failed(error.localizedDescription))
                    return
                }

                let deadline = Date().addingTimeInterval(timeoutSeconds)
                while p.isRunning, Date() < deadline {
                    Thread.sleep(forTimeInterval: 0.1)
                }
                if p.isRunning {
                    p.terminate()
                    cont.resume(throwing: BridgeError.timeout)
                    return
                }
                let out = outPipe.fileHandleForReading.readDataToEndOfFile()
                let err = errPipe.fileHandleForReading.readDataToEndOfFile()
                let text = String(data: out, encoding: .utf8)
                    ?? String(data: err, encoding: .utf8)
                    ?? ""
                if p.terminationStatus != 0 && text.isEmpty {
                    cont.resume(throwing: BridgeError.failed("codex exit \(p.terminationStatus)"))
                } else {
                    cont.resume(returning: text)
                }
            }
        }
    }
}
