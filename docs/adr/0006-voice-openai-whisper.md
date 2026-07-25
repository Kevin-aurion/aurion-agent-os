# ADR 0006 — 口述訓練語音輸入採 OpenAI Whisper（刻意的雲端例外）

**狀態**：已接受（2026-07，取代先前「本地 Whisper」的決定）

## 脈絡
「口述訓練」需語音轉文字。曾決議採本地 Whisper 以守住「不離地」；老闆最終決定先接 **OpenAI Whisper**（工程量小、品質穩定、免自架服務）。

## 決策
- 採 **OpenAI Whisper API**（`audio/transcriptions`）轉錄；需 `OPENAI_API_KEY`。
- 前端抽象為 `VoiceInput` port（`onTranscript(text)`）；後端 `POST /api/agents/:id/train/message` 仍只收文字 → **日後可換本地 Whisper 而不動上層**。
- 這是**第二個刻意的雲端例外**（第一個是 embedding 走 OpenRouter，見 `src/memory/CLAUDE.md`）。必須在文件明載，且：
  - 上傳前提醒使用者「音訊會送往 OpenAI」；
  - 轉錄結果落地前一律套用紅線 redactor；
  - 提供關閉開關（沿用 restrictions 思維，預設可關）。

## 後果
- 不需新增容器/基建，最快可上線。
- 「不離地」邊界擴大一項，需在對客戶說明時誠實列出（embedding、語音轉錄）。
- **前置條件未滿足**：`.env` 目前**沒有** `OPENAI_API_KEY` → 語音票在拿到金鑰前無法驗證。
