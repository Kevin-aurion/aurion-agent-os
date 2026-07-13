---
name: line-group-notify
kind: prompt_manual
description: 依據待處理檔案清單，撰寫一則簡潔的繁體中文 LINE 群組通知訊息。
declares:
  reads: []
  writes: [line:push]
  side_effects: [發送 LINE 群組訊息]
---
# LINE 群組通知撰寫

根據傳入的「未通知」檔案清單，撰寫一則要推送到 LINE 群組的訊息：

- 使用繁體中文，語氣專業、精簡。
- 條列每個待處理檔案：名稱 + 連結。
- 開頭一句總結（例：「以下 N 份檔案尚待處理」）。
- 全文不超過 4500 字。
- 只輸出訊息本文，不要加任何額外解釋。
