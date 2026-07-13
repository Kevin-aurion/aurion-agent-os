// The ONLY module agents/tools/routes should use to reach cloud data
// (Microsoft Graph / Google Drive+Gmail). Provider-agnostic, keyed by
// ConnectedAccount id, and every call is audited.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import * as XLSX from 'xlsx';
import type { ConnectedAccount } from '@prisma/client';
import { prisma } from '../lib/db.js';
import { paths } from '../config.js';
import { errors } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { getValidAccessToken } from './tokenstore.js';
import { graphFetch } from './microsoft.js';
import { driveClientFor, gmailClientFor } from './google.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface CloudEntry {
  id: string;
  name: string;
  kind: 'FILE' | 'FOLDER';
  mimeType?: string;
  path: string;
  webUrl?: string;
}

export interface CloudMessage {
  id: string;
  subject: string;
  from: string;
  receivedAt: string;
  snippet: string;
}

export interface CreatedFile {
  externalId: string;
  name: string;
  path: string;
  mimeType: string;
  kind: 'FILE';
  webUrl?: string;
}

async function loadAccount(accountId: string): Promise<ConnectedAccount> {
  const account = await prisma.connectedAccount.findUnique({ where: { id: accountId } });
  if (!account) throw errors.notFound(`ConnectedAccount ${accountId} not found`);
  return account;
}

// ── Drive / Files ─────────────────────────────────────────────────────────────

export async function listChildren(accountId: string, folderId?: string): Promise<CloudEntry[]> {
  const account = await loadAccount(accountId);
  const token = await getValidAccessToken(accountId);
  let entries: CloudEntry[];

  if (account.provider === 'MICROSOFT') {
    const segment = folderId ? `/me/drive/items/${folderId}/children` : '/me/drive/root/children';
    const res = await graphFetch(token, segment);
    entries = (res.value ?? []).map((it: any) => ({
      id: it.id,
      name: it.name,
      kind: it.folder ? 'FOLDER' : ('FILE' as const),
      mimeType: it.file?.mimeType,
      path: `${it.parentReference?.path ?? ''}/${it.name}`,
      webUrl: it.webUrl,
    }));
  } else {
    const drive = driveClientFor(token);
    const q = `'${folderId ?? 'root'}' in parents and trashed = false`;
    const res = await drive.files.list({ q, fields: 'files(id,name,mimeType,webViewLink)', pageSize: 200 });
    entries = (res.data.files ?? []).map((f) => ({
      id: f.id!,
      name: f.name ?? '',
      kind: f.mimeType === 'application/vnd.google-apps.folder' ? ('FOLDER' as const) : ('FILE' as const),
      mimeType: f.mimeType ?? undefined,
      path: f.name ?? '',
      webUrl: f.webViewLink ?? undefined,
    }));
  }

  await audit(account.userId, 'cloud.listChildren', 'ConnectedAccount', accountId, { folderId, count: entries.length });
  return entries;
}

export async function getFileMeta(accountId: string, fileId: string): Promise<CloudEntry> {
  const account = await loadAccount(accountId);
  const token = await getValidAccessToken(accountId);
  let entry: CloudEntry;

  if (account.provider === 'MICROSOFT') {
    const it = await graphFetch(token, `/me/drive/items/${fileId}`);
    entry = {
      id: it.id,
      name: it.name,
      kind: it.folder ? 'FOLDER' : 'FILE',
      mimeType: it.file?.mimeType,
      path: `${it.parentReference?.path ?? ''}/${it.name}`,
      webUrl: it.webUrl,
    };
  } else {
    const drive = driveClientFor(token);
    const res = await drive.files.get({ fileId, fields: 'id,name,mimeType,webViewLink' });
    entry = {
      id: res.data.id!,
      name: res.data.name ?? '',
      kind: res.data.mimeType === 'application/vnd.google-apps.folder' ? 'FOLDER' : 'FILE',
      mimeType: res.data.mimeType ?? undefined,
      path: res.data.name ?? '',
      webUrl: res.data.webViewLink ?? undefined,
    };
  }

  await audit(account.userId, 'cloud.getFileMeta', 'ConnectedAccount', accountId, { fileId });
  return entry;
}

/** Builds an .xlsx workbook (in-memory) modelling 應收應付帳款, with a header row
 * and sample rows — some flagged 未通知 so the finance workflow has something
 * to notice/act on. Returns the raw .xlsx file bytes. */
export function buildArApWorkbook(): Buffer {
  const header = ['單號', '對象(客戶/供應商)', '類型', '金額', '幣別', '到期日', '狀態', '備註'];
  const rows: (string | number)[][] = [
    ['AR-2026-001', '大立科技股份有限公司', '應收', 182000, 'TWD', '2026-07-20', '未通知', '首次帳款,尚未提醒'],
    ['AP-2026-014', '川崎材料有限公司', '應付', 96500, 'TWD', '2026-07-18', '已通知', '供應商已確認'],
    ['AR-2026-002', '昇陽電子', '應收', 254000, 'TWD', '2026-07-25', '未通知', ''],
    ['AP-2026-015', '東亞物流', '應付', 43200, 'TWD', '2026-07-15', '已通知', '已排款'],
    ['AR-2026-003', '美聯貿易', '應收', 88000, 'USD', '2026-08-02', '未通知', '需再確認匯率'],
    ['AP-2026-016', '光合材料', '應付', 120000, 'TWD', '2026-07-22', '已通知', ''],
    ['AR-2026-004', '正德工程', '應收', 310000, 'TWD', '2026-08-10', '未通知', '大額客戶,優先處理'],
    ['AP-2026-017', '恆昌五金', '應付', 67800, 'TWD', '2026-07-19', '已通知', ''],
  ];
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '應收應付');
  return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }) as Buffer;
}

/** Builds an .xlsx workbook (in-memory) modelling 月營收 (monthly revenue) across
 * a few product lines, with header row + ~12 rows of realistic TWD figures. */
export function buildRevenueWorkbook(): Buffer {
  const header = ['月份', '產品線', '營收', '成本', '毛利', '毛利率', '備註'];
  const rows: (string | number)[][] = [
    ['2026-01', '雲端服務', 3120000, 1450000, 1670000, '53.5%', ''],
    ['2026-02', '雲端服務', 2980000, 1390000, 1590000, '53.4%', '春節工作日較少'],
    ['2026-03', '雲端服務', 3350000, 1520000, 1830000, '54.6%', ''],
    ['2026-04', '雲端服務', 3410000, 1560000, 1850000, '54.3%', ''],
    ['2026-01', '硬體設備', 1860000, 1240000, 620000, '33.3%', ''],
    ['2026-02', '硬體設備', 1720000, 1160000, 560000, '32.6%', ''],
    ['2026-03', '硬體設備', 2010000, 1330000, 680000, '33.8%', '新客戶採購'],
    ['2026-04', '硬體設備', 1950000, 1300000, 650000, '33.3%', ''],
    ['2026-01', '顧問服務', 980000, 410000, 570000, '58.2%', ''],
    ['2026-02', '顧問服務', 1050000, 440000, 610000, '58.1%', ''],
    ['2026-03', '顧問服務', 1120000, 470000, 650000, '58.0%', '新增專案'],
    ['2026-04', '顧問服務', 1080000, 450000, 630000, '58.3%', ''],
  ];
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '月營收');
  return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }) as Buffer;
}

/** Builds an .xlsx workbook (in-memory) modelling a monthly finance analysis
 * (損益關鍵科目 vs. 上月/預算), with header row + ~10 rows. */
export function buildFinanceAnalysisWorkbook(): Buffer {
  const header = ['科目', '本月', '上月', '變動%', '年度累計', '預算達成率', '註記'];
  const rows: (string | number | string)[][] = [
    ['營收', 6460000, 6120000, '+5.6%', 24870000, '102%', ''],
    ['銷貨成本', 3310000, 3170000, '+4.4%', 12680000, '98%', ''],
    ['毛利', 3150000, 2950000, '+6.8%', 12190000, '106%', ''],
    ['營業費用', 1420000, 1380000, '+2.9%', 5460000, '95%', '行銷費用增加'],
    ['研發費用', 680000, 660000, '+3.0%', 2610000, '101%', ''],
    ['管理費用', 390000, 400000, '-2.5%', 1520000, '92%', ''],
    ['EBITDA', 1180000, 1050000, '+12.4%', 4380000, '112%', ''],
    ['折舊攤銷', 210000, 205000, '+2.4%', 820000, '100%', ''],
    ['營業利益', 970000, 845000, '+14.8%', 3560000, '115%', ''],
    ['淨利', 780000, 690000, '+13.0%', 2890000, '110%', '所得稅費用已扣除'],
  ];
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '財務分析');
  return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }) as Buffer;
}

const MIME_BY_EXT: Record<string, string> = {
  '.xlsx': XLSX_MIME,
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.json': 'application/json',
};

/** Uploads ANY local file (e.g. a document produced during an agent run) to the
 * user's cloud drive under <folder>/ (default AIOS). Provider-agnostic; used by
 * the built-in `upload_to_cloud` tool for 報價單/報告等產出. */
export async function uploadLocalFile(
  accountId: string,
  localPath: string,
  fileName?: string,
  folder = 'AIOS',
): Promise<CreatedFile> {
  const fs = await import('node:fs');
  const pathMod = await import('node:path');
  const account = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId } });
  const name = fileName ?? pathMod.basename(localPath);
  const mime = MIME_BY_EXT[pathMod.extname(name).toLowerCase()] ?? 'application/octet-stream';
  const bytes = fs.readFileSync(localPath);
  const token = await getValidAccessToken(accountId);

  let created: CreatedFile;
  if (account.provider === 'MICROSOFT') {
    const segment = `/me/drive/root:/${encodeURIComponent(folder)}/${encodeURIComponent(name)}:/content`;
    const it = await graphFetch(token, segment, { method: 'PUT', headers: { 'Content-Type': mime }, body: bytes });
    created = {
      externalId: it.id,
      name: it.name,
      path: `${it.parentReference?.path ?? ''}/${it.name}`,
      mimeType: it.file?.mimeType ?? mime,
      kind: 'FILE',
      webUrl: it.webUrl,
    };
  } else {
    const drive = driveClientFor(token);
    const res = await drive.files.create({
      requestBody: { name, mimeType: mime },
      media: { mimeType: mime, body: Readable.from(bytes) },
      fields: 'id,name,webViewLink',
    });
    created = {
      externalId: res.data.id!,
      name: res.data.name ?? name,
      path: res.data.name ?? name,
      mimeType: mime,
      kind: 'FILE',
      webUrl: res.data.webViewLink ?? undefined,
    };
  }
  await audit(null, 'cloud.uploadLocalFile', 'ConnectedAccount', accountId, { name, mime, folder });
  return created;
}

/** Uploads workbook bytes to the user's cloud drive under /AIOS/<fileName>.xlsx
 * (provider-agnostic), returning metadata suitable for a CloudFileRef. Shared by
 * createSpreadsheet() and createSampleFile(). */
async function uploadWorkbook(account: ConnectedAccount, accountId: string, fileName: string, bytes: Buffer): Promise<CreatedFile> {
  const token = await getValidAccessToken(accountId);
  let created: CreatedFile;

  if (account.provider === 'MICROSOFT') {
    const segment = `/me/drive/root:/AIOS/${encodeURIComponent(fileName)}:/content`;
    const it = await graphFetch(token, segment, {
      method: 'PUT',
      headers: { 'Content-Type': XLSX_MIME },
      body: bytes,
    });
    created = {
      externalId: it.id,
      name: it.name,
      path: `${it.parentReference?.path ?? ''}/${it.name}`,
      mimeType: it.file?.mimeType ?? XLSX_MIME,
      kind: 'FILE',
      webUrl: it.webUrl,
    };
  } else {
    const drive = driveClientFor(token);
    const res = await drive.files.create({
      requestBody: { name: fileName, mimeType: XLSX_MIME },
      media: { mimeType: XLSX_MIME, body: Readable.from(bytes) },
      fields: 'id,name,webViewLink',
    });
    created = {
      externalId: res.data.id!,
      name: res.data.name ?? fileName,
      path: res.data.name ?? fileName,
      mimeType: XLSX_MIME,
      kind: 'FILE',
      webUrl: res.data.webViewLink ?? undefined,
    };
  }

  return created;
}

/** Creates a new spreadsheet file in the user's cloud drive (provider-agnostic)
 * seeded with the 應收應付 AR/AP template, and returns enough metadata to
 * register it as a CloudFileRef. */
export async function createSpreadsheet(accountId: string, name: string): Promise<CreatedFile> {
  const account = await loadAccount(accountId);
  const bytes = buildArApWorkbook();
  const fileName = `${name}.xlsx`;
  const created = await uploadWorkbook(account, accountId, fileName, bytes);

  await audit(account.userId, 'cloud.createSpreadsheet', 'ConnectedAccount', accountId, { name: fileName, externalId: created.externalId });
  return created;
}

const SAMPLE_FILE_KINDS = {
  arap: { builder: buildArApWorkbook, defaultName: '應收應付帳款-範例' },
  revenue: { builder: buildRevenueWorkbook, defaultName: '營收報告-範例' },
  finance: { builder: buildFinanceAnalysisWorkbook, defaultName: '財務分析-範例' },
} as const;

export type SampleFileKind = keyof typeof SAMPLE_FILE_KINDS;

/** Creates a sample workbook (AR/AP, revenue, or finance analysis) in the
 * user's cloud drive and returns metadata suitable for a CloudFileRef. */
export async function createSampleFile(accountId: string, kind: SampleFileKind, name?: string): Promise<CreatedFile> {
  const account = await loadAccount(accountId);
  const spec = SAMPLE_FILE_KINDS[kind];
  if (!spec) throw errors.badRequest(`Unknown sample file kind: ${kind}`);

  const bytes = spec.builder();
  const fileName = `${name ?? spec.defaultName}.xlsx`;
  const created = await uploadWorkbook(account, accountId, fileName, bytes);

  await audit(account.userId, 'cloud.createSampleFile', 'ConnectedAccount', accountId, { kind, name: fileName, externalId: created.externalId });
  return created;
}

/** Downloads a file's content to a local temp path under paths.cache and returns that path. */
export async function downloadFile(accountId: string, fileId: string): Promise<string> {
  const account = await loadAccount(accountId);
  const token = await getValidAccessToken(accountId);

  const dir = path.join(paths.cache, accountId);
  await fs.mkdir(dir, { recursive: true });
  const destPath = path.join(dir, fileId.replace(/[^a-zA-Z0-9_.-]/g, '_'));

  if (account.provider === 'MICROSOFT') {
    const buf: Buffer = await graphFetch(token, `/me/drive/items/${fileId}/content`);
    await fs.writeFile(destPath, buf);
  } else {
    const drive = driveClientFor(token);
    const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
    await fs.writeFile(destPath, Buffer.from(res.data as unknown as ArrayBuffer));
  }

  await audit(account.userId, 'cloud.downloadFile', 'ConnectedAccount', accountId, { fileId, destPath });
  return destPath;
}

// ── Mail ──────────────────────────────────────────────────────────────────────

export async function listMessages(accountId: string, query?: string): Promise<CloudMessage[]> {
  const account = await loadAccount(accountId);
  const token = await getValidAccessToken(accountId);
  let messages: CloudMessage[];

  if (account.provider === 'MICROSOFT') {
    const segment = query
      ? `/me/messages?$search="${encodeURIComponent(query)}"&$top=25`
      : '/me/messages?$top=25&$orderby=receivedDateTime desc';
    const res = await graphFetch(token, segment, query ? { headers: { ConsistencyLevel: 'eventual' } } : undefined);
    messages = (res.value ?? []).map((m: any) => ({
      id: m.id,
      subject: m.subject ?? '',
      from: m.from?.emailAddress?.address ?? '',
      receivedAt: m.receivedDateTime ?? '',
      snippet: m.bodyPreview ?? '',
    }));
  } else {
    const gmailApi = gmailClientFor(token);
    const list = await gmailApi.users.messages.list({ userId: 'me', q: query, maxResults: 25 });
    const ids = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
    messages = await Promise.all(
      ids.map(async (id) => {
        const msg = await gmailApi.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] });
        const headers = msg.data.payload?.headers ?? [];
        const get = (name: string) => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
        return {
          id,
          subject: get('Subject'),
          from: get('From'),
          receivedAt: get('Date'),
          snippet: msg.data.snippet ?? '',
        };
      }),
    );
  }

  await audit(account.userId, 'cloud.listMessages', 'ConnectedAccount', accountId, { query, count: messages.length });
  return messages;
}

export async function sendMail(
  accountId: string,
  input: { to: string; subject: string; body: string },
): Promise<{ id?: string }> {
  const account = await loadAccount(accountId);
  const token = await getValidAccessToken(accountId);
  let result: { id?: string } = {};

  if (account.provider === 'MICROSOFT') {
    await graphFetch(token, '/me/sendMail', {
      method: 'POST',
      body: JSON.stringify({
        message: {
          subject: input.subject,
          body: { contentType: 'Text', content: input.body },
          toRecipients: [{ emailAddress: { address: input.to } }],
        },
        saveToSentItems: true,
      }),
    });
  } else {
    const gmailApi = gmailClientFor(token);
    const raw = Buffer.from(
      `To: ${input.to}\r\nSubject: ${input.subject}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${input.body}`,
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const res = await gmailApi.users.messages.send({ userId: 'me', requestBody: { raw } });
    result = { id: res.data.id ?? undefined };
  }

  await audit(account.userId, 'cloud.sendMail', 'ConnectedAccount', accountId, { to: input.to, subject: input.subject });
  return result;
}
