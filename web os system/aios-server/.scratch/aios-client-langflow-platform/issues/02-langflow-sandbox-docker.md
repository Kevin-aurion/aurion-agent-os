# 02 — 隔離的 Langflow FDE Sandbox

**Phase:** 2
**Blocked by:** None — can start immediately
**Status:** ready-for-agent

## What to build

建立版本固定、loopback-only、無正式憑證且不隨預設 compose 啟動的 Langflow Authoring／Sandbox Lab。

## To-Do List

- [ ] 新增獨立 sandbox compose 與啟停文件
- [ ] 固定 Langflow 版本與 localhost port
- [ ] 使用可丟棄 volume 與去識別測試資料
- [ ] 檢查環境變數、mount、network 皆無 Production secret

## Acceptance criteria

- [ ] 健康檢查可達且只綁 127.0.0.1
- [ ] 預設 docker compose up 不會啟動 Langflow
- [ ] compose config 不含 AIOS／provider 正式憑證

## Exact likely files

- web os system/docker-compose.langflow-sandbox.yml
- web os system/README.langflow-sandbox.md

## Existing patterns to reuse

- 現有 docker-compose loopback、healthcheck、named volume

## Must not modify

- 現有 docker-compose.yml
- aios-server／aios-web source

## Verification

- docker compose config
- 啟動後 health probe
- plain compose service list 不含 sandbox

## Positive / negative tests

- 正向：local health 200
- 負向：非 loopback URL 與 credential-bearing config 驗證失敗
