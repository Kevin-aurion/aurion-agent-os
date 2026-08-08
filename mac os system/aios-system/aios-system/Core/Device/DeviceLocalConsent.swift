import AppKit
import Foundation

/// Local NSAlert consent before sensitive device actions.
@MainActor
enum DeviceLocalConsent {
    enum Action: String {
        case computerControl = "電腦操控 (Computer Use)"
        case screenshot = "螢幕截圖"
        case mcpInstall = "安裝 LINE Desktop MCP"
        case lineSend = "透過 LINE Desktop 傳送訊息"
        case lineRead = "讀取 LINE Desktop 訊息"
    }

    /// Returns true if the user approved.
    static func confirm(action: Action, detail: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = "裝置任務需要您的確認"
        alert.informativeText = """
        操作：\(action.rawValue)

        \(detail)

        僅在本機核准後才會繼續。拒絕將以失敗回報伺服器（fail-closed）。
        """
        alert.alertStyle = .warning
        alert.addButton(withTitle: "核准執行")
        alert.addButton(withTitle: "拒絕")
        NSApp.activate(ignoringOtherApps: true)
        return alert.runModal() == .alertFirstButtonReturn
    }

    static func confirmDisconnect(deviceId: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = "中斷並清除裝置註冊？"
        alert.informativeText = """
        裝置 ID：\(deviceId)

        這會中斷 WebSocket、清除本機 Keychain 中的裝置憑證，並停止任務執行。
        伺服器端的裝置紀錄不會自動刪除（需 FDE 在管理介面撤銷）。
        """
        alert.alertStyle = .critical
        alert.addButton(withTitle: "中斷並清除")
        alert.addButton(withTitle: "取消")
        NSApp.activate(ignoringOtherApps: true)
        return alert.runModal() == .alertFirstButtonReturn
    }
}
