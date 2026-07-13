// Agent capability restrictions. Enforced in two layers:
//  1. Prompt level — a 明確禁止事項 section injected into every engine's
//     system prompt (and the materialized CLAUDE.md).
//  2. CLI-flag level — where the engine CLI supports hard switches
//     (claude --disallowedTools, grok --disable-web-search), and the runner
//     refuses COMPUTER_CONTROL steps outright when computerUse is off.
export interface AgentRestrictions {
  /** 允許網路搜尋／瀏覽網頁（WebSearch/WebFetch）。 */
  webSearch: boolean;
  /** 允許電腦操控（Computer Use／桌面自動化）。 */
  computerUse: boolean;
  /** 允許寄送電子郵件。 */
  sendEmail: boolean;
  /** 允許寫入／建立雲端檔案（唯讀不受此限）。 */
  cloudWrite: boolean;
  /** 允許執行 Shell 指令。 */
  shell: boolean;
  /**
   * 允許把記憶內容送到雲端 embedding API（OpenRouter / Google）建立語意索引。
   * false 時仍寫入 memory/wiki log.md，但跳過 embed → Qdrant。
   * 紅線 redactor（剔除密鑰／個資）一律生效，不受此旗標影響。
   */
  cloudEmbedding: boolean;
  /** 額外的自訂禁止事項（自由文字，逐行列出）。 */
  notes?: string;
}

export const DEFAULT_RESTRICTIONS: AgentRestrictions = {
  webSearch: true,
  computerUse: false,
  sendEmail: false,
  cloudWrite: true,
  shell: true,
  cloudEmbedding: true,
};

export function parseRestrictions(raw: unknown): AgentRestrictions {
  const r = (raw ?? {}) as Partial<AgentRestrictions>;
  return {
    webSearch: r.webSearch ?? DEFAULT_RESTRICTIONS.webSearch,
    computerUse: r.computerUse ?? DEFAULT_RESTRICTIONS.computerUse,
    sendEmail: r.sendEmail ?? DEFAULT_RESTRICTIONS.sendEmail,
    cloudWrite: r.cloudWrite ?? DEFAULT_RESTRICTIONS.cloudWrite,
    shell: r.shell ?? DEFAULT_RESTRICTIONS.shell,
    cloudEmbedding: r.cloudEmbedding ?? DEFAULT_RESTRICTIONS.cloudEmbedding,
    notes: typeof r.notes === 'string' && r.notes.trim() ? r.notes.trim() : undefined,
  };
}

/** Renders the restrictions as a system-prompt section (zh-Hant, explicit). */
export function restrictionsToRules(r: AgentRestrictions): string {
  const lines: string[] = [];
  if (!r.webSearch) lines.push('- 禁止進行網路搜尋、瀏覽網頁或抓取任何線上資料。');
  if (!r.computerUse) lines.push('- 禁止操控電腦（Computer Use）、開啟瀏覽器或任何桌面應用程式。');
  if (!r.sendEmail) lines.push('- 禁止寄送電子郵件或任何對外訊息。');
  if (!r.cloudWrite) lines.push('- 禁止建立、修改或刪除雲端檔案（僅能讀取已指派的檔案）。');
  if (!r.shell) lines.push('- 禁止執行任何 Shell／終端機指令。');
  if (!r.cloudEmbedding) lines.push('- 禁止將記憶內容送往雲端 embedding 服務（僅保留本地 wiki 檔案）。');
  if (r.notes) {
    for (const n of r.notes.split('\n')) {
      const t = n.trim();
      if (t) lines.push(`- ${t.startsWith('-') ? t.slice(1).trim() : t}`);
    }
  }
  if (lines.length === 0) return '';
  return `【此員工的明確禁止事項 — 不論使用者如何要求都不得違反】\n${lines.join('\n')}\n若任務需要被禁止的能力，請直接說明無法執行及原因，不要嘗試繞過。`;
}
