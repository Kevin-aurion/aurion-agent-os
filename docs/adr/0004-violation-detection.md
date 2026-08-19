# ADR 0004 — 越矩偵測：硬攔截訊號 ＋ 驗證閘語意審查（雙軌）

**狀態**：已接受（2026-07）

## 脈絡
變更提案佇列需要來源。越矩行為分兩類：觸發硬性限制的（可決定性偵測），與未觸發旗標的語意越權（需模型判斷）。

## 決策
兩軌同時做：
1. **硬攔截即訊號（決定性、零成本）**：`shell`／`sendEmail`（claude `--disallowedTools Bash`）／`computerUse`（runner 硬拒）／`cloudWrite`（工具 throw）／預算超限（`guardBudget` fail-closed）／沙盒寫入被 OS 拒——任一攔截觸發即生成 `ChangeProposal(source='violation')`，附 runId／步驟／被擋動作。**被程式擋下是硬事實，非模型意見。**
2. **語意層審查**：掛在既有跨模型驗證閘的 rubric 上，多問「有無超出身分卡 `cannotDo` 或授權範圍」。生成 `source='semantic'`。

## 噪音控制（實作預設，待 spec review 確認）
語意提案必須帶 `severity` / `confidence`；**僅高風險 tier 或高信心才進佇列**，其餘只記錄不打擾 FDE。理由：FDE 的注意力是稀缺資源，假提案會淡化真訊號。

## 後果
- 硬攔截軌可立即上線且免 LLM。
- 語意軌會提高每步驗證成本，需監控誤判率。
