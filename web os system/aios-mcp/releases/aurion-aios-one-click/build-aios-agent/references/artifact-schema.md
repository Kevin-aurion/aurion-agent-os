# AIOS external Agent artifact

Read this reference before the first `sync_agent_build_artifact` call. Send a complete current snapshot every time.

## Required identity

```json
{
  "identity": {
    "name": "客戶回款追蹤員",
    "purpose": "每天整理到期應收帳款，標示異常並產生可人工覆核的追蹤清單。",
    "workingStyle": [
      "先核對原始資料，再提出結論",
      "資料不完整時列入待確認，不自行猜測"
    ]
  }
}
```

`agentMarkdown` and `claudeMarkdown` are optional complete Markdown drafts. Do not put secrets in them.

## Skills

Provide structured fields and, when available, the complete `contentMd` that should become `SKILL.md` after testing and FDE approval.

```json
{
  "skills": [
    {
      "name": "應收帳款比對",
      "purpose": "把銀行收款與未沖帳發票形成配對草稿。",
      "instructions": [
        "先以交易序號唯一配對",
        "找不到唯一結果時比較日期與金額",
        "一對多、多對一或低信心結果一律要求人工確認"
      ],
      "inputs": ["銀行交易明細", "ERP 未沖帳清單"],
      "outputs": ["配對草稿", "待確認候選清單"],
      "edgeCases": ["缺少交易序號", "同金額不同客戶", "一筆款項對多張發票"],
      "contentMd": "---\nname: 應收帳款比對\ndescription: ...\n---\n\n# 應收帳款比對\n..."
    }
  ]
}
```

## Memory

Facts are stable business facts. Preferences describe how this user wants work performed. Glossary explains organization-specific terms. Documents are relative Markdown paths only.

```json
{
  "memory": {
    "facts": ["ERP 使用交易序號作為主要比對鍵"],
    "preferences": ["所有模糊配對都要列出原因"],
    "glossary": ["未沖帳：ERP 中尚未完成收款沖銷的發票"],
    "documents": [
      {
        "path": "decisions/matching-policy.md",
        "purpose": "目前有效的配對決策",
        "contentMd": "# 配對政策\n\n1. 交易序號優先..."
      }
    ]
  }
}
```

Absolute paths and `..` traversal are rejected. AIOS writes these files only after tests and FDE finalization.

## Tools and policies

Do not claim a tool is authorized merely because the user requested it. AIOS downgrades unverified tool availability to `NEEDS_FDE`.

```json
{
  "tools": [
    {"name": "Gmail MCP", "purpose": "讀取付款通知", "status": "NEEDS_FDE"}
  ],
  "policies": {
    "allowed": ["讀取使用者提供的測試資料", "產生可覆核草稿"],
    "requiresApproval": ["寄信", "寫入 ERP", "啟動排程"],
    "forbidden": ["自行刪除交易", "未確認即完成模糊配對"]
  }
}
```

## Workflows

Use only these step types: `DO`, `TOOL`, `AGENT`, `CONDITION`, `NOTIFY`, `COMPUTER_CONTROL`. Keep tool calls explicit in `config`; never include credentials or webhook plaintext secrets.

```json
{
  "workflows": [
    {
      "name": "每日回款檢查",
      "description": "讀取資料、比對並輸出待確認清單。",
      "trigger": {"type": "manual"},
      "durable": true,
      "steps": [
        {
          "stepKey": "read-inputs",
          "type": "DO",
          "config": {"instruction": "讀取銀行交易與 ERP 未沖帳資料"},
          "verifyRubric": "必須列出兩個資料來源與資料期間"
        },
        {
          "stepKey": "match-items",
          "type": "DO",
          "config": {"instruction": "依已確認規則形成配對與候選清單"},
          "verifyRubric": "不得自動完成一對多、多對一或低信心配對"
        }
      ]
    }
  ]
}
```

Imported workflows remain disabled after finalization until an FDE separately checks triggers and connections.

## Tests and understanding

Each test needs concrete input and an observable expected result. Include positive, ambiguous and forbidden-action cases when relevant.

```json
{
  "tests": [
    {
      "name": "一對多不得自動沖帳",
      "input": "一筆 20,000 元銀行款可能對到兩張各 10,000 元發票。",
      "expected": "列出兩張候選發票並要求人工確認；不得寫入 ERP。"
    }
  ],
  "understanding": {
    "northStar": "縮短回款核對時間，但不犧牲正確性。",
    "facts": [
      {"statement": "交易序號是最可信比對鍵", "source": "使用者第 3 輪確認"}
    ],
    "decisions": [
      {"topic": "模糊配對", "decision": "一律要求人工確認", "status": "confirmed"}
    ],
    "openBranches": [],
    "contradictions": [],
    "confidence": 80
  },
  "userSummary": "我已加入一對多的人工確認規則與測試。",
  "fdeSummary": "新增模糊配對 guardrail；Gmail 與 ERP 連線仍需 FDE 驗證。"
}
```

## Full-snapshot rule

On every artifact sync, include all currently valid identity, Skills, memory, tools, policies, workflows and tests. If the user withdraws something, remove it from the new snapshot and add an explicit `changes` item with `action: removed`. Never send only the new paragraph as if it were the whole employee.
