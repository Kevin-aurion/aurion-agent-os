# 票 03 — 工作台內整合訓練

## 範圍

- 在同一 composer 切換「交代工作／教它新工作」。
- 訓練模式使用既有 train/message API 並顯示理解結果。
- 支援既有 OpenAI 語音轉錄入口。
- 支援既有桌面錄製 start/status/stop/to-skill。
- FDE 可確認掛載，MEMBER 只能送提案。

## 驗收

- Skill 永不自動 CONFIRMED。
- 錄製錯誤原樣以安全訊息呈現，不模擬成功。
- MEMBER 無法呼叫 trainer-only 確認操作。
- 訓練結果卡呈現能力、資料讀寫、外部呼叫、不可逆動作與風險。
