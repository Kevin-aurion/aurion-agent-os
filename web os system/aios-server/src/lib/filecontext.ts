// Gather the content of an agent's assigned cloud file targets as readable
// text, so a chat/workflow run can actually reason over the live cloud data
// (the "指定同步到雲端硬碟的特定檔案，並讀取該 Excel 內容" capability).
import * as XLSX from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from './db.js';
import { downloadFile } from '../integrations/cloud.js';
import { parseDocumentFile } from './docparse.js';

const MAX_CHARS = 8000;

function xlsxToText(localPath: string): string {
  const wb = XLSX.read(fs.readFileSync(localPath));
  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name]!, { header: 1, blankrows: false });
    parts.push(`# 工作表：${name}`);
    for (const r of rows) {
      const line = (r as unknown[]).map((c) => (c == null ? '' : String(c))).join(' | ');
      if (line.replace(/\|/g, '').trim()) parts.push(line);
    }
  }
  return parts.join('\n');
}

const SPREADSHEET_EXTS = new Set(['.xlsx', '.xls']);
const DOCUMENT_EXTS = new Set([
  '.pdf',
  '.docx',
  '.doc',
  '.pptx',
  '.ppt',
  '.png',
  '.jpg',
  '.jpeg',
  '.tiff',
  '.bmp',
]);

function isSpreadsheet(name: string, mimeType?: string): boolean {
  const ext = path.extname(name).toLowerCase();
  if (SPREADSHEET_EXTS.has(ext)) return true;
  if ((mimeType ?? '').toLowerCase().includes('spreadsheet')) return true;
  return false;
}

function isDocument(name: string, mimeType?: string): boolean {
  const ext = path.extname(name).toLowerCase();
  if (DOCUMENT_EXTS.has(ext)) return true;
  const mime = (mimeType ?? '').toLowerCase();
  if (
    mime.includes('pdf') ||
    mime.includes('word') ||
    mime.includes('presentation') ||
    mime.includes('image')
  ) {
    return true;
  }
  return false;
}

/** 依副檔名/mime 把本地檔轉成可讀文字：試算表→表格文字；PDF/docx/pptx/圖片→Docling markdown；其餘→utf8。best-effort。 */
export async function fileToText(localPath: string, name: string, mimeType?: string): Promise<string> {
  if (isSpreadsheet(name, mimeType)) {
    return xlsxToText(localPath);
  }
  if (isDocument(name, mimeType)) {
    try {
      const parsed = await parseDocumentFile(localPath, name);
      const md = parsed.markdown ?? '';
      if (!md.trim()) return '（文件解析失敗或無文字）';
      return md;
    } catch {
      return '（文件解析失敗或無文字）';
    }
  }
  return fs.readFileSync(localPath, 'utf8');
}

/** Returns a text block describing all of the agent's cloud file targets and
 * their current content (best-effort; failures per-file are noted, not thrown). */
export async function gatherAgentFileContext(agentId: string): Promise<string> {
  const targets = await prisma.agentFileTarget.findMany({
    where: { agentId },
    include: { cloudFileRef: true },
  });
  if (targets.length === 0) return '';

  const blocks: string[] = [];
  for (const t of targets) {
    const ref = t.cloudFileRef;
    const header = `檔案：${ref.name}（路徑：${ref.path}${t.purpose ? '，用途：' + t.purpose : ''}）`;
    try {
      const localPath = await downloadFile(ref.accountId, ref.externalId);
      const body = await fileToText(localPath, ref.name, ref.mimeType ?? undefined);
      blocks.push(`${header}\n${body}`);
    } catch (e) {
      blocks.push(`${header}\n（讀取失敗：${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  let out = blocks.join('\n\n---\n\n');
  if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS) + '\n…（內容過長已截斷）';
  return out;
}
