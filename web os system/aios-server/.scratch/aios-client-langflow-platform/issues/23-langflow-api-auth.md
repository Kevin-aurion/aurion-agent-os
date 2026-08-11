# 23 — Langflow Production Flow API 認證

**Phase:** 6
**Blocked by:** 17 — Langflow Production isolation
**Status:** ready-for-agent

## Defect（live 證據）

`LangflowAdapter.deployArtifact()` 與 `execute()` 會呼叫 Langflow Flow API，Production Runtime 保持 `LANGFLOW_AUTO_LOGIN=false` 後，未認證請求會正確 fail-closed 回 403。現行 Adapter 沒有攜帶 Langflow credential，因此正式 deploy／execute 永遠無法成功。

Langflow 1.5+ 官方支援以 `LANGFLOW_API_KEY_SOURCE=env`、`LANGFLOW_API_KEY=<secret>` 建立 backend-only 單租戶 API key，呼叫端以 `x-api-key` header 傳送。不得改成 auto-login 或 skip-auth。

## What to build

- Production compose 加入 `LANGFLOW_API_KEY_SOURCE=env`，API key 必須從 `${AIOS_LANGFLOW_PRODUCTION_API_KEY:?…}` 引用；禁止 hardcode、禁止 `env_file`、禁止 provider credential。
- `LangflowAdapterConfig` 支援 `apiKey`，所有 Langflow HTTP 請求統一附加 `x-api-key`；key 需 trim、非空、拒絕 CR/LF/control character，且任何 error／trace／log 不得洩漏。
- `resolveRuntimeAdapter('LANGFLOW')` 必須同時要求 runtime URL 與 `AIOS_LANGFLOW_PRODUCTION_API_KEY`；任一缺失都 fail-closed。
- 本機 `.env` 建立高熵 Langflow API key 與 Production secret，檔案維持 gitignored 且權限 0600；值不得寫入測試、文件、tool output 或版控。
- 文件更新啟動、輪替與 header 契約；保持 loopback-only、backend-only、AUTO_LOGIN=false。

## Acceptance criteria

- [ ] Adapter deploy／execute／resume／health 共用的 HTTP helper 都會附加相同 `x-api-key`。
- [ ] mock server 能觀察到正確 header；錯誤文字即使回顯 key 也會被 redactor 遮罩。
- [ ] 缺 key、空白 key、CRLF key 都 fail-closed，且 zero network call。
- [ ] Production compose 缺 `AIOS_LANGFLOW_PRODUCTION_API_KEY` 時 `docker compose config` 失敗；有 dummy secret/key 時隔離 validator 全綠。
- [ ] Production Runtime 重建後，無 header 的 Flow API 仍為 403；帶後端 key 的只讀 Flow API 為 2xx。
- [ ] 以 AIOS `LangflowAdapter` 做一次 live flow deploy，取得 `langflow:flow:<id>` binding；若建立測試 flow，必須清理。
- [ ] server `npx tsc --noEmit`、t03、t17、t23 全綠。

## Exact likely files

- `src/runtime/langflow.ts`
- `src/lib/runtimedeployment.ts`
- `docker-compose.langflow-production.yml`
- `README.langflow-production.md`
- `.scratch/aios-client-langflow-platform/tests/t23-langflow-api-auth.test.ts`
- t17 compose isolation test（只補 control-plane API key allowlist 與 fail-closed 斷言）

## Must not modify

- `LANGFLOW_AUTO_LOGIN=false`、loopback bind、read-only rootfs、network/volume 隔離
- Provider key denylist、AIOS JWT／encryption key 隔離
- Skill confirm、FDE deployment gate、execute≠verify、redactor
- 既有 migration、`lazyoffice-system-main`、使用者其他 WIP
- 不 commit／push

## Verification

1. 先寫負向測試：missing／blank／CRLF key、header omission、secret reflection。
2. t23 + t03 + t17。
3. server typecheck。
4. 重建 production container；HTTP 403/2xx 對照。
5. Adapter live deploy + cleanup；報告不得印出 key。
