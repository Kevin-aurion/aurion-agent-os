// Client for the local Docling document-parse service (aios-docparse).
// Converts PDF / scanned docs / office files → Markdown + structured IR.
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { config } from '../config.js';

export interface ParsedDoc {
  status: string;
  markdown: string;
  ir?: unknown;
}

/**
 * POST a file to Docling (`/v1/convert/file`) and return parsed Markdown + IR.
 * Throws a clear error if the service is down or the response is not success.
 */
export async function parseDocumentFile(absPath: string, filename?: string): Promise<ParsedDoc> {
  const name = filename ?? path.basename(absPath);
  const bytes = await readFile(absPath);
  const fd = new FormData();
  fd.append('files', new Blob([bytes]), name);
  fd.append('to_formats', 'md');

  const base = config.docparse.url.replace(/\/$/, '');
  let res: Response;
  try {
    res = await fetch(`${base}/v1/convert/file`, { method: 'POST', body: fd });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`docparse: 無法連線 ${base} — ${msg}`);
  }

  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`docparse: 非 JSON 回應 HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const detail = json?.message ?? json?.detail ?? text.slice(0, 200);
    throw new Error(`docparse: HTTP ${res.status} — ${detail}`);
  }

  const status = typeof json.status === 'string' ? json.status : '';
  if (status && status !== 'success') {
    throw new Error(`docparse: status=${status} — ${JSON.stringify(json.errors ?? json).slice(0, 300)}`);
  }

  const markdown = json.document?.md_content ?? '';
  const ir = json.document?.json_content;
  return { status: status || 'success', markdown, ir };
}

/** GET /health on the docparse service; returns false on any failure. */
export async function docparseHealthy(): Promise<boolean> {
  const base = config.docparse.url.replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/health`, { method: 'GET' });
    if (!res.ok) return false;
    const json = (await res.json()) as { status?: string };
    return json.status === 'ok';
  } catch {
    return false;
  }
}
