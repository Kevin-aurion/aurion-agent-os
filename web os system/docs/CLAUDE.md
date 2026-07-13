# docs — 文件與測試報告

## 內容
- `test-report/` — **五案例端對端實測報告**。
  - `index.html` — 自成一體（inline CSS）的中文報告：系統概述、測試環境、5 案例（員工建立、技能訓練、輸入參數、工作流步驟、欄位說明、實際輸出、GIF）、Bug 修復、結論。
  - `img/` — 各案例操作 GIF（case1–case5）與截圖。
  - `PLAN.md` — 測試計畫（5 案例對照表）。

## 五案例（2026-07-13，全數通過）
1. 每日帳款掃描（財務長，定期）
2. 報價單生成→上傳（財務長，手動；展示驗證閘 reject→重跑）
3. AI 新聞日報（企劃專員，GROK 檢索）
4. 技能訓練→對話（行政秘書；含對話記憶）
5. 限制驗證（市場研究員，關網搜→正確拒絕）

## 檢視報告
in-app 瀏覽器擋 `file://`，可起簡易靜態伺服器：
```bash
cd docs/test-report && python3 -m http.server 8791   # 或 node 靜態伺服器
```
或直接用系統瀏覽器開 `index.html`。深入架構見 [`../ARCHITECTURE.md`](../ARCHITECTURE.md)。
