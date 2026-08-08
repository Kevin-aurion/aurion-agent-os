import Foundation
import AppKit

/// **RETIRED** public-AWP Computer Control path.
///
/// Historical behavior opened Codex and reported `dispatched` as success over
/// `computer.control_result`. That is **forbidden** under the multi-device
/// execution platform: durable `DeviceTask` + `/device/ws` is the only path,
/// and success requires proven completion (never mere app launch).
///
/// Kept as a fail-closed stub so any residual AWP `computer.control_requested`
/// events never report fake success. Prefer `DeviceAgentService` / `DeviceTaskExecutor`.
final class ComputerControlExecutor {
    static let shared = ComputerControlExecutor()

    func handle(_ frame: AwpFrame, awp: AwpClient) {
        let taskId = frame.payload?["taskId"]?.stringValue ?? ""
        // Do NOT open Codex. Do NOT send dispatched=success.
        DispatchQueue.main.async {
            DeviceAgentService.shared.appendLog(
                taskId: taskId.isEmpty ? nil : taskId,
                level: .error,
                message: "RETIRED: computer.control_requested via public AWP ignored. Use DeviceTask COMPUTER_CONTROL on /device/ws."
            )
            let alert = NSAlert()
            alert.messageText = "舊版電腦操控路徑已停用"
            alert.informativeText = """
            public AWP 的 computer.control_requested 已退役。
            請透過已註冊的裝置通道（DeviceTask / COMPUTER_CONTROL）執行。
            本 App 不會再把「開啟 Codex」回報為成功。
            """
            alert.alertStyle = .informational
            alert.addButton(withTitle: "了解")
            alert.runModal()
        }
        // Explicit failure signal to hub if still listening (honest, not success).
        if !taskId.isEmpty {
            awp.send(
                kind: "req",
                topic: "computer.control_result",
                payload: [
                    "taskId": taskId,
                    "status": "failed",
                    "error": "RETIRED_PUBLIC_AWP_COMPUTER_CONTROL",
                ]
            )
        }
    }
}
