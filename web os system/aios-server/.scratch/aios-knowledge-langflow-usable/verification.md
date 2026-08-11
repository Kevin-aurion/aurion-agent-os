# AI 知識採集 Langflow Sandbox 驗收紀錄

驗收日期：2026-08-11（Asia/Taipei）

## 結論

- Sandbox 查詢閉環可用：本地索引 → 證據閘門 → Langflow → 回答／引用 → redacted trace。
- 知識索引共 311 筆來源；Langflow Flow ID 為 `4ec97062-f088-45b6-a304-a4fe1d1c9f26`。
- Sandbox 成功不等於 Production 啟用；正式環境仍須 Eval 與 FDE 核准。

## 實跑證據

- Backend unit：5 passed / 0 failed。
- Studio presentation unit：4 passed / 0 failed。
- Backend typecheck、build：passed。
- Studio typecheck、build：passed。
- Langflow 原生 Flow deploy + run marker：passed。
- Adapter contract：45 passed / 0 failed / 0 blocked。
- Runtime boundary：179 passed / 0 failed / 1 expected blocked（canonical AIOS IR 不是 Langflow 原生 graph；不是本 Pilot 的失敗）。
- API integration：FDE 查詢成功，4 筆引用，5 個 trace stage 全部成功。
- 權限負向驗證：未登入 401、MEMBER 403、空白輸入 400。
- 落地紀錄：3 個 JSON record 均為 `0600`，與目前環境 secret 值比對為 0 命中。
- 公開 Studio Browser E2E：登入、查詢「MCP server 應該怎麼配置？」、等待完成、看到回答／時間碼引用／trace，瀏覽器 console 0 error、0 warning。
- 公開頁面：`https://aios-studio.lazyoffice.app/studio/runtime` 回應 200。
- 本機服務：AIOS server、AIOS Studio、Langflow Sandbox 均為 running；Langflow 容器 healthy。

## 已知依賴風險

- Studio production dependencies：0 vulnerabilities。
- Backend audit 原先有可無破壞升級修正的 `fast-uri`、`find-my-way`、`undici`；已執行 non-breaking audit fix 並重跑驗證。
- `xlsx` 上游仍有無修正版的 high advisories；現有匯入路徑必須持續套用檔案大小／格式限制，不應把未信任試算表內容當可執行資料。
- `uuid` advisories 位於 Azure／Google dependency chain；完整修正會牽涉 breaking upgrade，需獨立升級票處理。
