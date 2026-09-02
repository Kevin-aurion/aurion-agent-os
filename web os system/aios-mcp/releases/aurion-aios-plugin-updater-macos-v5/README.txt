Aurion AIOS Plugin 安裝／更新工具
================================

這個工具給不熟悉 Command Line 的使用者。

macOS
-----
1. 解壓縮下載的 ZIP。
2. 雙擊「Aurion AIOS Updater.app」。安裝或更新會在背景進行，不需要輸入指令。
3. 如果瀏覽器自動開啟，請登入自己的 AIOS 帳號並同意授權。
4. 看到完成訊息後，重新開啟 Claude 或 Codex。

若 macOS 第一次阻擋開啟：
請對 App 按右鍵 →「打開」→ 再按一次「打開」。這是 macOS 對尚未簽章之下載工具的安全提示。
若 App 無法顯示結果，可雙擊同一資料夾內的「Aurion AIOS Updater.command」查看詳細進度。

Windows
-------
1. 解壓縮下載的 ZIP。
2. 雙擊「Aurion AIOS Updater.vbs」。安裝或更新會在背景進行，不需要輸入指令。
3. 如果瀏覽器自動開啟，請登入自己的 AIOS 帳號並同意授權。
4. 看到完成訊息後，重新開啟 Claude 或 Codex。

Windows 更新器只會針對這次執行啟用 PowerShell，不會永久修改系統執行原則。
若電腦停用了 VBScript，可雙擊同一資料夾內的「Aurion AIOS Updater.cmd」；它會顯示相同流程的詳細進度。
若直接在 ZIP 預覽裡雙擊 VBS，工具會從 Aurion 官方網址自動下載並檢查完整套件，不會再誤報「檔案不完整」。

安全說明
--------
- 更新器不會讀取、顯示或保存密碼、OAuth Token 或 API Key。
- 登入由 Claude／Codex 官方 CLI 開啟瀏覽器處理。
- 遠端 MCP 固定為：https://aurion-aios-mcp.lazyoffice.app/mcp
- 沒有安裝 Aurion AIOS Plugin 時，本工具會自動安裝；已安裝時會更新。
- 如果 Claude Code 與 Codex 都不存在，本工具會先從 OpenAI 官方網址安裝 Codex CLI，再繼續安裝 Plugin 與 MCP 授權。
- 若特別需要 Claude Code，請依 Anthropic 官方說明另外安裝；只安裝 Codex 也能建立和使用 AI 員工。
