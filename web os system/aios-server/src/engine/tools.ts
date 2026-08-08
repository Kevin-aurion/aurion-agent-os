// Tool registry: dynamically loads an agent's tools/<name>.js|.ts and runs it,
// plus a deterministic (no-LLM) boolean expression evaluator used by
// CONDITION steps.
import path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface ToolContext {
  agentId: string;
  agentDir: string;
  /** From the agent's restrictions (engine/restrictions.ts). */
  cloudWrite: boolean;
  /** From the agent's restrictions — gate email-sending tools (groundwork; no built-in email tool yet). */
  sendEmail: boolean;
  /** Optional run id — used for VIOLATION proposal linkage when a hard block fires. */
  runId?: string;
  /** Authenticated actor / run trigger for governed MCP audit attribution. */
  userId?: string;
}

export interface ToolModule {
  meta?: { description?: string; input?: Record<string, string> };
  run: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<unknown> | unknown;
}

// ── Built-in tools (available to every agent without a tools/ dir) ──────────

/**
 * upload_to_cloud — uploads files produced during a run (paths relative to
 * the agent workspace) to the user's connected cloud drive.
 * args: { files: string[] (relative paths), accountId?: string, folder?: string }
 */
const uploadToCloud: ToolModule = {
  meta: {
    description: '將執行過程產出的檔案上傳到已連動的雲端硬碟（Google Drive / OneDrive）',
    input: { files: '相對於工作目錄的檔案路徑陣列', accountId: '（選填）雲端帳號 id，未填則取第一個已連動帳號', folder: '（選填）雲端資料夾，預設 AIOS' },
  },
  async run(args, ctx) {
    if (!ctx) throw new Error('upload_to_cloud requires tool context');
    if (!ctx.cloudWrite) {
      // Hard block unchanged — still throw. Extra: fail-safe VIOLATION signal (ADR 0004).
      const { recordViolation } = await import('../lib/changeproposal.js');
      await recordViolation({
        agentId: ctx.agentId,
        runId: ctx.runId,
        kind: 'cloud_write',
        detail: { tool: 'upload_to_cloud', message: 'cloudWrite restriction blocked upload' },
      });
      throw new Error('RESTRICTED: 此員工未開啟「寫入雲端檔案」權限，無法上傳。');
    }
    const files = Array.isArray(args.files) ? (args.files as string[]) : [];
    if (files.length === 0) throw new Error('upload_to_cloud: args.files 為空');
    const { uploadLocalFile } = await import('../integrations/cloud.js');
    const { prisma } = await import('../lib/db.js');
    let accountId = typeof args.accountId === 'string' && args.accountId ? args.accountId : undefined;
    if (!accountId) {
      const acct = await prisma.connectedAccount.findFirst({ where: { status: 'CONNECTED' }, orderBy: { createdAt: 'asc' } });
      if (!acct) throw new Error('upload_to_cloud: 沒有已連動的雲端帳號');
      accountId = acct.id;
    }
    const folder = typeof args.folder === 'string' && args.folder ? args.folder : 'AIOS';
    const uploaded = [];
    for (const rel of files) {
      if (/\.\./.test(rel) || path.isAbsolute(rel)) throw new Error(`upload_to_cloud: 不允許的路徑 ${rel}`);
      const abs = path.join(ctx.agentDir, rel);
      if (!existsSync(abs)) throw new Error(`upload_to_cloud: 找不到檔案 ${rel}`);
      uploaded.push(await uploadLocalFile(accountId, abs, path.basename(rel), folder));
    }
    return { uploaded };
  },
};

/**
 * parse_document — parse a workspace file (PDF / scan / office) via local
 * Docling into Markdown. Local read-only; no restriction flag required.
 * args: { file: string } — path relative to the agent workspace.
 */
const parseDocument: ToolModule = {
  meta: {
    description: '將工作區內的 PDF／掃描件／文件解析為 Markdown（本地 Docling 服務）',
    input: { file: '相對於工作目錄的檔案路徑' },
  },
  async run(args, ctx) {
    if (!ctx) throw new Error('parse_document requires tool context');
    const rel = typeof args.file === 'string' ? args.file : '';
    if (!rel) throw new Error('parse_document: args.file 為空');
    if (/\.\./.test(rel) || path.isAbsolute(rel)) throw new Error(`parse_document: 不允許的路徑 ${rel}`);
    const abs = path.join(ctx.agentDir, rel);
    if (!existsSync(abs)) throw new Error(`parse_document: 找不到檔案 ${rel}`);
    const { parseDocumentFile } = await import('../lib/docparse.js');
    const result = await parseDocumentFile(abs, path.basename(rel));
    return { markdown: result.markdown, status: result.status };
  },
};

const BUILTIN_TOOLS: Record<string, ToolModule> = {
  upload_to_cloud: uploadToCloud,
  parse_document: parseDocument,
};

/** Dynamically import agentDir/tools/<name>.{js,ts}, else a built-in tool. */
export async function loadTool(agentDir: string, toolName: string): Promise<ToolModule> {
  // Tool name must not escape the tools/ dir.
  if (!toolName || /[\\/]|\.\./.test(toolName)) {
    throw new Error(`Invalid tool name: ${toolName}`);
  }
  const base = path.join(agentDir, 'tools', toolName);
  const candidate = ['.js', '.ts'].map((ext) => `${base}${ext}`).find((p) => existsSync(p));
  if (candidate) {
    const mod = (await import(pathToFileURL(candidate).href)) as ToolModule;
    if (typeof mod.run !== 'function') {
      throw new Error(`Tool "${toolName}" does not export run()`);
    }
    return mod;
  }
  const builtin = BUILTIN_TOOLS[toolName];
  if (builtin) return builtin;
  throw new Error(`Tool not found: ${base}.(js|ts)（亦非內建工具）`);
}

/** Load and execute a tool by name with resolved args. */
export async function runTool(agentDir: string, toolName: string, args: Record<string, unknown>, ctx?: ToolContext): Promise<unknown> {
  const mcp = /^mcp:([A-Za-z0-9._-]+):([A-Za-z0-9._-]+)$/.exec(toolName);
  if (mcp) {
    if (!ctx) throw new Error('MCP tool requires governed tool context');
    const [, serverId, externalTool] = mcp;
    const writeTools = new Set(['gmail_create_draft', 'gmail_send', 'drive_create_text_file']);
    const callArgs =
      writeTools.has(externalTool!) && ctx.runId && args.runId == null
        ? { ...args, runId: ctx.runId }
        : args;
    const { brokerDispatch } = await import('../lib/mcpbroker.js');
    return brokerDispatch({
      agentId: ctx.agentId,
      userId: ctx.userId,
      runId: ctx.runId,
      serverId: serverId!,
      tool: externalTool!,
      args: callArgs,
    });
  }
  const mod = await loadTool(agentDir, toolName);
  return mod.run(args, ctx);
}

/**
 * Deterministic CONDITION expression evaluator (no LLM, no I/O). The caller
 * pre-resolves `{{...}}` tokens via `resolve` (same identity./steps.
 * templating as elsewhere); this substitutes each resolved value as a JSON
 * literal into the expression and evaluates the result as a boolean JS
 * expression. Expressions come from agent/workflow authors (a trusted
 * config surface, not end-user input) — same trust boundary as the rest of
 * the workflow definition. Any parse/eval error fails closed to false.
 */
export function evalCondition(expr: string, resolve: (token: string) => unknown): boolean {
  try {
    const substituted = expr.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, inner: string) => JSON.stringify(resolve(inner)));
    // eslint-disable-next-line no-new-func
    const fn = new Function(`"use strict"; return (${substituted});`);
    return Boolean(fn());
  } catch {
    return false;
  }
}
