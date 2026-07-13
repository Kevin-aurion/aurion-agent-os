import Foundation
import AppKit

/// Host-side executor for COMPUTER_CONTROL workflow steps. When the backend
/// emits `computer.control_requested`, this launches the Codex app to run the
/// user's recorded skill, then reports the result back over AWP/1.
///
/// NOTE: the actual automation is performed by Codex (screen-recording skill);
/// this class only bridges the request to the host GUI and reports completion.
final class ComputerControlExecutor {
    static let shared = ComputerControlExecutor()

    func handle(_ frame: AwpFrame, awp: AwpClient) {
        let taskId = frame.payload?["taskId"]?.stringValue ?? ""
        let skillName = frame.payload?["skillName"]?.stringValue ?? "自動化技能"

        DispatchQueue.main.async {
            let alert = NSAlert()
            alert.messageText = "代理要求執行電腦操作"
            alert.informativeText = "技能「\(skillName)」需要透過 Codex 操作電腦。要現在執行嗎？"
            alert.addButton(withTitle: "執行")
            alert.addButton(withTitle: "略過")
            let run = alert.runModal() == .alertFirstButtonReturn
            if run {
                self.launchCodex()
                awp.send(kind: "req", topic: "computer.control_result", payload: ["taskId": taskId, "status": "dispatched"])
            } else {
                awp.send(kind: "req", topic: "computer.control_result", payload: ["taskId": taskId, "status": "skipped"])
            }
        }
    }

    private func launchCodex() {
        // Prefer opening the Codex desktop app; fall back to the CLI path.
        if let codex = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.openai.codex") {
            NSWorkspace.shared.openApplication(at: codex, configuration: NSWorkspace.OpenConfiguration())
        } else {
            NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications"))
        }
    }
}
