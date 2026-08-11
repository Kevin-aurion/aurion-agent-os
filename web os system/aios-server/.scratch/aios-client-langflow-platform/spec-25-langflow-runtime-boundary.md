# Spec 25 — Langflow Runtime 環境邊界與執行結果契約

## Outcome

AIOS 對 Langflow 的每一次 deploy／execute／resume，都必須由該次部署的 `DeploymentEnvironment` 決定 endpoint 與 control-plane credential。Sandbox、Staging、Production 不得共用或回退到 Production credential。Langflow 的 HTTP 2xx 只代表傳輸成功；AIOS 必須驗證回應契約並取得至少一個有效輸出，才可將 Run 標為 `SUCCEEDED`。

## Environment configuration

| Environment | URL | API key |
|---|---|---|
| SANDBOX | `AIOS_LANGFLOW_SANDBOX_URL` | `AIOS_LANGFLOW_SANDBOX_API_KEY` |
| STAGING | `AIOS_LANGFLOW_STAGING_URL` | `AIOS_LANGFLOW_STAGING_API_KEY` |
| PRODUCTION | `AIOS_LANGFLOW_RUNTIME_URL` | `AIOS_LANGFLOW_PRODUCTION_API_KEY` |

- LANGFLOW adapter resolution requires an explicit environment.
- Missing／blank／invalid URL or key rejects before network I/O.
- There is no fallback between environments and no global Production default.
- NATIVE runtime does not require a Langflow environment.
- Artifact structural validation remains deterministic/local and must not need a remote credential.

## Execution response contract

For non-streaming `POST /api/v1/run/{flowId}`:

- Body must be a JSON object with a non-empty `outputs` array.
- At least one outer output item must contain a non-empty nested `outputs` array.
- Explicit error-bearing payloads, malformed JSON, missing arrays, or empty effective outputs are failures even with HTTP 2xx.
- A valid response produces a bounded, deep-redacted normalized output event before terminal success.
- AIOS persists the normalized output on the Run; credentials, prompt-injection secrets, raw stack traces, and unbounded response bodies must not reach WS, trace, DB error text, or logs.

## Durable resume binding

When a Langflow execution asks for approval, the server-generated ApprovalRequest payload records the deployment id and environment. Resume must re-load that exact active deployment, verify it matches the Run artifact, and resolve the adapter from the recorded environment. Missing, stale, mismatched, or client-invented metadata fails closed.

## Security invariants

- Flow IDs returned by deploy and read from runtime bindings use one shared safe parser: 1–128 characters, first character alphanumeric, remaining characters alphanumeric/`.`/`_`/`-` only.
- Parser errors never reflect untrusted `kind`, binding, URL credential, response body, or API key.
- Loopback URLs containing username/password are rejected.
- FDE-only deployment, Skill confirmation, digest, Eval, execute≠verify, budget, rate-limit, circuit-breaker, DLQ, audit, and redactor gates are unchanged.
