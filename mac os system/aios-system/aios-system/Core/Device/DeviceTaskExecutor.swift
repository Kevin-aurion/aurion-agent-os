import CoreGraphics
import Foundation

/// Durable device task executor. DB task is source of truth; WS is only a wake.
actor DeviceTaskExecutor {
    private var activeTaskIds: Set<String> = []
    private var cancelledTaskIds: Set<String> = []
    private var confirmationContinuations: [String: CheckedContinuation<Bool, Never>] = [:]
    private var artifactSeq: [String: Int] = [:]

    private let log: @Sendable (String?, DeviceTaskLogEntry.Level, String) -> Void

    init(log: @escaping @Sendable (String?, DeviceTaskLogEntry.Level, String) -> Void) {
        self.log = log
    }

    func markCancelled(taskId: String) {
        cancelledTaskIds.insert(taskId)
        if let cont = confirmationContinuations.removeValue(forKey: taskId) {
            cont.resume(returning: false)
        }
    }

    func notifyConfirmed(taskId: String) {
        if let cont = confirmationContinuations.removeValue(forKey: taskId) {
            cont.resume(returning: true)
        }
    }

    /// Fetch open tasks from REST and process any not already active.
    func fetchAndProcessOpenTasks() async throws {
        do {
            let tasks = try await DeviceAPIClient.shared.listOpenTasks()
            for t in tasks where t.isOpen {
                try await handleTaskId(t.id, preferred: t)
            }
        } catch let e as DeviceAPIClient.APIError where e.isAuthFailure {
            log(nil, .error, "Auth failure listing tasks — stop until re-enroll")
            throw e
        } catch let e as DeviceAPIClient.APIError {
            throw e
        } catch {
            log(nil, .warn, "listOpenTasks failed: \(error.localizedDescription)")
        }
    }

    func handleTaskId(_ taskId: String, preferred: DeviceTaskDTO? = nil) async throws {
        guard !activeTaskIds.contains(taskId) else { return }
        activeTaskIds.insert(taskId)
        defer { activeTaskIds.remove(taskId) }

        do {
            try await runTask(taskId: taskId, preferred: preferred)
        } catch let e as DeviceAPIClient.APIError where e.isAuthFailure {
            log(taskId, .error, "Auth failure on task — \(e.message)")
            throw e
        } catch {
            log(taskId, .error, "Task failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Core lifecycle

    private func runTask(taskId: String, preferred: DeviceTaskDTO?) async throws {
        if cancelledTaskIds.contains(taskId) {
            log(taskId, .warn, "Task already cancelled locally")
            return
        }

        var task: DeviceTaskDTO
        if let preferred {
            task = preferred
        } else {
            task = try await DeviceAPIClient.shared.getTask(taskId)
        }
        guard task.isOpen else {
            log(taskId, .info, "Task \(task.status) — skip")
            return
        }

        // Validate kind + payload locally (fail closed).
        let payloadDict = task.payload?.asDictionary() ?? [:]
        let kind: DeviceTaskKindName
        let payload: [String: Any]
        do {
            guard let k = DeviceTaskPayloadValidator.parseKind(task.kind) else {
                throw DeviceTaskPayloadValidator.ValidationError(message: "Unsupported kind \(task.kind)")
            }
            kind = k
            payload = try DeviceTaskPayloadValidator.validate(kind: k, payload: payloadDict)
        } catch {
            log(taskId, .error, "Payload rejected: \(error.localizedDescription)")
            // Try to ack then fail if we can; otherwise just log.
            if let acked = try? await DeviceAPIClient.shared.ack(taskId: taskId),
               let leaseId = acked.leaseId
            {
                _ = try? await DeviceAPIClient.shared.result(
                    taskId: taskId,
                    leaseId: leaseId,
                    status: "FAILED",
                    error: ["message": error.localizedDescription, "code": "INVALID_PAYLOAD"]
                )
            }
            return
        }

        log(taskId, .info, "ACK \(kind.rawValue)")
        task = try await DeviceAPIClient.shared.ack(taskId: taskId, leaseMs: 60_000)
        guard let leaseId = task.leaseId else {
            log(taskId, .error, "ACK returned no leaseId — fail closed")
            return
        }

        let renewer = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                guard !Task.isCancelled else { break }
                do {
                    _ = try await DeviceAPIClient.shared.renewLease(taskId: taskId, leaseId: leaseId)
                } catch {
                    self?.log(taskId, .warn, "lease renew failed: \(error.localizedDescription)")
                }
            }
        }
        defer { renewer.cancel() }

        // Local cancellation / expiry check.
        if cancelledTaskIds.contains(taskId) || isExpired(task) {
            _ = try? await DeviceAPIClient.shared.result(
                taskId: taskId,
                leaseId: leaseId,
                status: "FAILED",
                error: ["message": "cancelled or expired before execute", "code": "CANCELLED_OR_EXPIRED"]
            )
            return
        }

        _ = try await DeviceAPIClient.shared.progress(
            taskId: taskId,
            leaseId: leaseId,
            progress: ["phase": "RUNNING", "kind": kind.rawValue],
            status: "RUNNING"
        )

        do {
            switch kind {
            case .capabilityProbe:
                try await execCapabilityProbe(taskId: taskId, leaseId: leaseId)
            case .screenshot:
                try await execScreenshot(taskId: taskId, leaseId: leaseId, payload: payload, requireConfirm: task.confirmationRequired == true)
            case .computerControl:
                try await execComputerControl(taskId: taskId, leaseId: leaseId, payload: payload, requireConfirm: task.confirmationRequired != false)
            case .mcpInstall:
                try await execMcpInstall(taskId: taskId, leaseId: leaseId, payload: payload)
            case .lineDesktop:
                try await execLineDesktop(taskId: taskId, leaseId: leaseId, payload: payload)
            case .mcpTool:
                try await execMcpTool(taskId: taskId, leaseId: leaseId, payload: payload)
            }
        } catch {
            let latest = try? await DeviceAPIClient.shared.getTask(taskId)
            if cancelledTaskIds.contains(taskId) || isExpired(latest) {
                _ = try? await DeviceAPIClient.shared.result(
                    taskId: taskId,
                    leaseId: leaseId,
                    status: "FAILED",
                    error: ["message": "cancelled or expired", "code": "CANCELLED_OR_EXPIRED"]
                )
            } else {
                _ = try? await DeviceAPIClient.shared.result(
                    taskId: taskId,
                    leaseId: leaseId,
                    status: "FAILED",
                    error: ["message": error.localizedDescription, "code": "EXEC_FAILED"]
                )
            }
            log(taskId, .error, error.localizedDescription)
        }
    }

    // MARK: - Kind handlers

    private func execCapabilityProbe(taskId: String, leaseId: String) async throws {
        let (doc, detail) = DeviceCapabilitiesProbe.probe(includeMcp: true)
        _ = try await DeviceAPIClient.shared.putCapabilities(doc)
        let result: [String: Any] = [
            "capabilities": encodeToDict(doc),
            "notes": detail.notes,
        ]
        _ = try await DeviceAPIClient.shared.result(
            taskId: taskId,
            leaseId: leaseId,
            status: "SUCCEEDED",
            result: result
        )
        log(taskId, .success, "Capability probe reported")
    }

    private func execScreenshot(
        taskId: String,
        leaseId: String,
        payload: [String: Any],
        requireConfirm: Bool
    ) async throws {
        let approved = await MainActor.run {
            DeviceLocalConsent.confirm(
                action: .screenshot,
                detail: "將擷取指定 App/視窗截圖並上傳為任務產物。"
            )
        }
        guard approved else {
            throw SimpleError("User denied screenshot")
        }
        try throwIfCancelled(taskId)

        let app = payload["app"] as? String
        let window = payload["window"] as? String
        var region: CGRect?
        if let r = payload["region"] as? [String: Any],
           let x = r["x"] as? Double ?? (r["x"] as? Int).map(Double.init),
           let y = r["y"] as? Double ?? (r["y"] as? Int).map(Double.init),
           let w = r["width"] as? Double ?? (r["width"] as? Int).map(Double.init),
           let h = r["height"] as? Double ?? (r["height"] as? Int).map(Double.init)
        {
            region = CGRect(x: x, y: y, width: w, height: h)
        }

        let capture = try await DeviceScreenshotCapture.capture(app: app, window: window, region: region)
        let art = try await uploadScreenshot(taskId: taskId, capture: capture)

        if requireConfirm {
            _ = try await DeviceAPIClient.shared.progress(
                taskId: taskId,
                leaseId: leaseId,
                progress: ["phase": "AWAITING_CONFIRM", "artifactId": art.id],
                status: "AWAITING_CONFIRM",
                confirmationArtifactId: art.id
            )
            log(taskId, .info, "Awaiting human confirm for screenshot \(art.id)")
            let ok = await waitForConfirmation(taskId: taskId, timeoutSeconds: 600)
            guard ok else {
                throw SimpleError("Confirmation rejected, cancelled, or timed out")
            }
        }

        _ = try await DeviceAPIClient.shared.result(
            taskId: taskId,
            leaseId: leaseId,
            status: "SUCCEEDED",
            result: [
                "artifactId": art.id,
                "clientDeclaredRedacted": capture.clientDeclaredRedacted,
            ]
        )
        log(taskId, .success, "Screenshot task succeeded")
    }

    private func execComputerControl(
        taskId: String,
        leaseId: String,
        payload: [String: Any],
        requireConfirm: Bool
    ) async throws {
        let instructions = payload["instructions"] as? String
        let app = payload["app"] as? String
        let skillId = payload["skillId"] as? String
        let skillVersionId = payload["skillVersionId"] as? String
        let detail = [
            "app": app ?? "—",
            "skillId": skillId ?? skillVersionId ?? "—",
            "instructions": String((instructions ?? "").prefix(200)),
        ].map { "\($0.key): \($0.value)" }.joined(separator: "\n")

        let approved = await MainActor.run {
            DeviceLocalConsent.confirm(action: .computerControl, detail: detail)
        }
        guard approved else { throw SimpleError("User denied Computer Use") }
        try throwIfCancelled(taskId)

        // Always attempt checkpoint screenshot when confirmation required.
        var artifactId: String?
        let needShot: Bool = {
            if let cp = payload["checkpoint"] as? [String: Any],
               let req = cp["requireScreenshot"] as? Bool
            {
                return req
            }
            return requireConfirm
        }()

        if needShot {
            let shotApproved = await MainActor.run {
                DeviceLocalConsent.confirm(
                    action: .screenshot,
                    detail: "Computer Use 檢查點需要截圖。"
                )
            }
            if shotApproved {
                do {
                    let capture = try await DeviceScreenshotCapture.capture(app: app, window: payload["window"] as? String, region: nil)
                    let art = try await uploadScreenshot(taskId: taskId, capture: capture)
                    artifactId = art.id
                } catch {
                    // Fail closed on checkpoint capture when required.
                    throw SimpleError("Checkpoint screenshot failed (fail-closed): \(error.localizedDescription)")
                }
            } else if requireConfirm {
                throw SimpleError("User denied checkpoint screenshot")
            }
        }

        if requireConfirm {
            guard let artifactId else {
                throw SimpleError("confirmationRequired but no screenshot artifact (fail-closed)")
            }
            _ = try await DeviceAPIClient.shared.progress(
                taskId: taskId,
                leaseId: leaseId,
                progress: ["phase": "AWAITING_CONFIRM", "artifactId": artifactId],
                status: "AWAITING_CONFIRM",
                confirmationArtifactId: artifactId
            )
            log(taskId, .info, "Awaiting confirm before/during Computer Use (\(artifactId))")
            let ok = await waitForConfirmation(taskId: taskId, timeoutSeconds: 600)
            guard ok else {
                throw SimpleError("Human rejected or confirmation timed out")
            }
        }

        try throwIfCancelled(taskId)

        // Real bridge attempt — never report mere launch as success.
        // Pre-action confirmation checkpoint (above) is preserved when requireConfirm.
        do {
            let outcome = try await ComputerUseBridge.execute(
                instructions: instructions,
                app: app,
                skillId: skillId ?? skillVersionId,
                timeoutSeconds: 180
            )
            // Even if bridge returns, proven=false means we must not claim SUCCEEDED for GUI work.
            // ADR 0005 path typically remains unproven — honest FAILED.
            if outcome.proven {
                // Proven completion requires post-action scoped screenshot as evidence.
                let postArt: DeviceArtifactDTO
                do {
                    let postCapture = try await DeviceScreenshotCapture.capture(
                        app: app,
                        window: payload["window"] as? String,
                        region: nil
                    )
                    postArt = try await uploadScreenshot(taskId: taskId, capture: postCapture)
                } catch {
                    throw SimpleError(
                        "Post-action screenshot/upload failed (fail-closed): \(error.localizedDescription)"
                    )
                }
                var resultBody: [String: Any] = [
                    "summary": outcome.summary,
                    "details": outcome.details,
                    "postActionArtifactId": postArt.id,
                    "evidence": "post-action-screenshot",
                ]
                if let artifactId {
                    resultBody["checkpointArtifactId"] = artifactId
                }
                _ = try await DeviceAPIClient.shared.result(
                    taskId: taskId,
                    leaseId: leaseId,
                    status: "SUCCEEDED",
                    result: resultBody
                )
                log(taskId, .success, "Computer Use proven success with post-action evidence \(postArt.id)")
            } else {
                throw SimpleError(outcome.summary)
            }
        } catch {
            var errBody: [String: Any] = [
                "message": error.localizedDescription,
                "code": "COMPUTER_USE_UNPROVEN",
            ]
            if let artifactId { errBody["checkpointArtifactId"] = artifactId }
            _ = try await DeviceAPIClient.shared.result(
                taskId: taskId,
                leaseId: leaseId,
                status: "FAILED",
                error: errBody
            )
            log(taskId, .error, "Computer Use failed honestly: \(error.localizedDescription)")
        }
    }

    private func execMcpInstall(taskId: String, leaseId: String, payload: [String: Any]) async throws {
        // Re-validate fixed manifest (ignore any drift).
        _ = try DeviceTaskPayloadValidator.validate(kind: .mcpInstall, payload: payload)
        let prereqs = LineDesktopMcpRuntime.prerequisiteReport()

        let approved = await MainActor.run {
            DeviceLocalConsent.confirm(
                action: .mcpInstall,
                detail: """
                將安裝固定版本 line-desktop-mcp \(LineDesktopMcpManifest.pinned.version)。
                SHA-256 將於安裝前驗證。
                不會執行 Homebrew 或自動安裝 Node/cliclick。
                npm install 使用 --ignore-scripts；主 tarball digest 為信任邊界（transitive deps 仍由 npm 解析）。

                前置條件檢查：
                \(prereqs.isEmpty ? "（基本路徑看起來可用）" : prereqs.joined(separator: "\n"))
                """
            )
        }
        guard approved else { throw SimpleError("User denied MCP install") }
        try throwIfCancelled(taskId)

        try await LineDesktopMcpRuntime.installPinned(userApproved: true)
        let ready = LineDesktopMcpRuntime.probeReadyInstallation()
        if ready == nil {
            throw SimpleError("Install finished but READY verification failed (tarball re-hash / exact tools)")
        }

        // Capability reconciliation PUT is required — fail closed if it fails.
        let (doc, _) = DeviceCapabilitiesProbe.probe(includeMcp: true)
        do {
            _ = try await DeviceAPIClient.shared.putCapabilities(doc)
        } catch {
            throw SimpleError(
                "MCP install package READY locally but capability PUT failed (fail-closed): \(error.localizedDescription)"
            )
        }

        _ = try await DeviceAPIClient.shared.result(
            taskId: taskId,
            leaseId: leaseId,
            status: "SUCCEEDED",
            result: [
                "mcpKey": LineDesktopMcpManifest.pinned.mcpKey,
                "version": LineDesktopMcpManifest.pinned.version,
                "sha256": LineDesktopMcpManifest.pinned.sha256,
                "tools": LineDesktopMcpManifest.pinned.toolAllowlist,
                "prerequisites": prereqs,
                "trustBoundary": "pinned-main-tarball-sha256; transitive npm deps not digested",
            ]
        )
        log(taskId, .success, "LINE MCP installed, capabilities reconciled, READY")
    }

    private func execLineDesktop(taskId: String, leaseId: String, payload: [String: Any]) async throws {
        let operation = payload["operation"] as? String ?? ""
        let tool = payload["tool"] as? String ?? defaultTool(for: operation)
        let args = payload["args"] as? [String: Any]

        guard LineDesktopMcpManifest.pinned.isAllowedTool(tool) else {
            throw SimpleError("Tool not allowlisted: \(tool)")
        }

        let isSend = LineDesktopMcpManifest.pinned.isSendTool(tool) || operation == "send"
        let action: DeviceLocalConsent.Action = isSend ? .lineSend : .lineRead
        let approved = await MainActor.run {
            DeviceLocalConsent.confirm(
                action: action,
                detail: "tool=\(tool)\noperation=\(operation)"
            )
        }
        guard approved else { throw SimpleError("User denied LINE Desktop action") }
        try throwIfCancelled(taskId)

        let result = try await LineDesktopMcpRuntime.call(tool: tool, args: args)
        let encoded = stringifyResult(result)
        _ = try await DeviceAPIClient.shared.result(
            taskId: taskId,
            leaseId: leaseId,
            status: "SUCCEEDED",
            result: [
                "tool": tool,
                "operation": operation,
                "result": encoded,
            ]
        )
        log(taskId, .success, "LINE Desktop \(tool) completed")
    }

    private func execMcpTool(taskId: String, leaseId: String, payload: [String: Any]) async throws {
        // Only device-local LINE MCP is supported in this agent for now.
        let serverId = payload["serverId"] as? String ?? ""
        let tool = payload["tool"] as? String ?? ""
        let args = payload["args"] as? [String: Any]

        let m = LineDesktopMcpManifest.pinned
        guard serverId == m.mcpKey || serverId == m.packageName || serverId == "line-desktop" else {
            throw SimpleError("Unknown MCP serverId (only line-desktop-mcp supported locally): \(serverId)")
        }
        guard m.isAllowedTool(tool) else {
            throw SimpleError("Tool not allowlisted: \(tool)")
        }
        let isSend = m.isSendTool(tool)
        let approved = await MainActor.run {
            DeviceLocalConsent.confirm(
                action: isSend ? .lineSend : .lineRead,
                detail: "MCP_TOOL server=\(serverId) tool=\(tool)"
            )
        }
        guard approved else { throw SimpleError("User denied MCP tool") }
        let result = try await LineDesktopMcpRuntime.call(tool: tool, args: args)
        _ = try await DeviceAPIClient.shared.result(
            taskId: taskId,
            leaseId: leaseId,
            status: "SUCCEEDED",
            result: [
                "serverId": serverId,
                "tool": tool,
                "result": stringifyResult(result),
            ]
        )
        log(taskId, .success, "MCP tool \(tool) completed")
    }

    // MARK: - Helpers

    private func uploadScreenshot(taskId: String, capture: DeviceScreenshotCapture.CaptureResult) async throws -> DeviceArtifactDTO {
        let seq = (artifactSeq[taskId] ?? 0)
        artifactSeq[taskId] = seq + 1
        // Do NOT attest redacted=true unless rules actually ran.
        var metaAny: [String: Any] = [:]
        for (k, v) in capture.meta { metaAny[k] = v }
        return try await DeviceAPIClient.shared.uploadArtifact(
            taskId: taskId,
            seq: seq,
            kind: "SCREENSHOT",
            mimeType: "image/png",
            data: capture.pngData,
            clientDeclaredRedacted: capture.clientDeclaredRedacted,
            meta: metaAny
        )
    }

    private func waitForConfirmation(taskId: String, timeoutSeconds: TimeInterval) async -> Bool {
        await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            confirmationContinuations[taskId] = cont
            Task { [weak self] in
                let deadline = Date().addingTimeInterval(timeoutSeconds)
                while Date() < deadline {
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    guard let self else { return }
                    // Already resumed by notifyConfirmed / markCancelled?
                    if await self.confirmationContinuations[taskId] == nil { return }
                    if let t = try? await DeviceAPIClient.shared.getTask(taskId) {
                        if t.confirmedAt != nil {
                            await self.resumeConfirmation(taskId, true)
                            return
                        }
                        if t.status == "CANCELLED" || t.status == "FAILED" || t.status == "TIMEOUT" {
                            await self.resumeConfirmation(taskId, false)
                            return
                        }
                        if t.status == "RUNNING" || t.status == "SUCCEEDED" {
                            await self.resumeConfirmation(taskId, true)
                            return
                        }
                    }
                    if await self.cancelledTaskIds.contains(taskId) {
                        await self.resumeConfirmation(taskId, false)
                        return
                    }
                }
                await self?.resumeConfirmation(taskId, false)
            }
        }
    }

    private func resumeConfirmation(_ taskId: String, _ value: Bool) {
        if let c = confirmationContinuations.removeValue(forKey: taskId) {
            c.resume(returning: value)
        }
    }

    private func isCancelled(_ taskId: String) -> Bool {
        cancelledTaskIds.contains(taskId)
    }

    private func throwIfCancelled(_ taskId: String) throws {
        if cancelledTaskIds.contains(taskId) {
            throw SimpleError("Task cancelled")
        }
    }

    private func isExpired(_ task: DeviceTaskDTO?) -> Bool {
        guard let task, let deadline = task.deadlineAt else { return false }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = f.date(from: deadline)
        if date == nil {
            f.formatOptions = [.withInternetDateTime]
            date = f.date(from: deadline)
        }
        guard let date else { return false }
        return Date() > date
    }

    private func defaultTool(for operation: String) -> String {
        operation == "send" ? "send_message_manual" : "get_line_chatroom_history_default"
    }

    private func encodeToDict<T: Encodable>(_ value: T) -> [String: Any] {
        guard let data = try? JSONEncoder().encode(value),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        return obj
    }

    private func stringifyResult(_ value: Any) -> Any {
        if JSONSerialization.isValidJSONObject(value) { return value }
        return String(describing: value)
    }

    private struct SimpleError: Error, LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }
}
