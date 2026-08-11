import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ulid } from 'ulid';
import { z } from 'zod';
import { config, paths } from '../config.js';
import { deepRedactSecrets } from '../memory/deepredact.js';
import { redactSecrets } from '../memory/redactor.js';
import type { NormalizedRunEvent, RuntimeAdapter } from '../runtime/adapter.js';
import { resolveRuntimeAdapter } from './runtimedeployment.js';
import { assertInsideRoot, safeJoin } from './safepath.js';
import { audit as writeAudit } from './audit.js';

const execFileAsync = promisify(execFile);

export const KNOWLEDGE_PILOT_FLOW_NAME = 'AI 知識採集 — Grounded Langflow Sandbox';
export const KNOWLEDGE_PILOT_MAX_QUESTION = 800;
const KNOWLEDGE_PILOT_MAX_OUTPUT_BYTES = 600_000;
const KNOWLEDGE_INDEX_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 12_000;

const searchHitSchema = z.object({
  score: z.number().finite().nonnegative(),
  video_id: z.string().min(1).max(160),
  title: z.string().min(1).max(600),
  channel: z.string().min(1).max(300),
  matched_tools: z.array(z.string().max(200)).max(8),
  matched_concepts: z.array(z.string().max(200)).max(8),
  evidence_kind: z.string().max(100).nullish(),
  evidence_label: z.string().max(500).nullish(),
  evidence_text: z.string().max(20_000),
  timestamp: z.string().regex(/^\d{1,3}:\d{2}(?::\d{2})?$/),
  evidence_url: z.string().url().max(2_000),
  wiki_source: z
    .string()
    .max(1_000)
    .refine((value) => !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..'))
    .nullish(),
});

const searchPayloadSchema = z.object({
  query: z.string().min(1).max(KNOWLEDGE_PILOT_MAX_QUESTION),
  results: z.array(searchHitSchema).max(8),
});

export type KnowledgeSearchHit = z.infer<typeof searchHitSchema>;
export type KnowledgeSearchPayload = z.infer<typeof searchPayloadSchema>;

export type KnowledgeCitation = {
  id: number;
  title: string;
  channel: string;
  label: string | null;
  excerpt: string;
  timestamp: string;
  url: string;
  wikiSource: string | null;
  matchedTools: string[];
  score: number;
};

export type KnowledgePilotTraceStep = {
  key: 'validate_input' | 'query_index' | 'evidence_gate' | 'langflow_sandbox' | 'persist_trace';
  label: string;
  status: 'SUCCEEDED' | 'FAILED' | 'NON_BLOCKING_FAILURE';
  durationMs: number;
  detail: string;
};

export type KnowledgePilotRecord = {
  id: string;
  flowId: string;
  flowName: string;
  environment: 'SANDBOX';
  runtimeKind: 'LANGFLOW';
  status: 'SUCCEEDED' | 'FAILED';
  question: string;
  answer: string;
  citations: KnowledgeCitation[];
  trace: KnowledgePilotTraceStep[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  error: string | null;
};

export type KnowledgePilotDeps = {
  search?: (question: string, limit: number) => Promise<KnowledgeSearchPayload>;
  runtime?: RuntimeAdapter;
  persist?: (record: KnowledgePilotRecord) => Promise<void>;
  audit?: (record: KnowledgePilotRecord, actorId: string) => Promise<void>;
  now?: () => Date;
};

export class KnowledgePilotRunError extends Error {
  constructor(
    message: string,
    public readonly record: KnowledgePilotRecord,
  ) {
    super(redactSecrets(message));
    this.name = 'KnowledgePilotRunError';
  }
}

function clampText(value: string, max: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= max ? compact : `${compact.slice(0, max)}…`;
}

export function parseKnowledgeSearchOutput(stdout: string): KnowledgeSearchPayload {
  if (Buffer.byteLength(stdout, 'utf8') > KNOWLEDGE_PILOT_MAX_OUTPUT_BYTES) {
    throw new Error('知識索引回應超過安全上限');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('知識索引回應不是有效 JSON');
  }
  const checked = searchPayloadSchema.safeParse(parsed);
  if (!checked.success) {
    throw new Error('知識索引回應格式不符');
  }
  return deepRedactSecrets(checked.data);
}

async function resolveKnowledgeFiles(): Promise<{
  root: string;
  script: string;
  index: string;
}> {
  const root = await realpath(config.knowledgePilot.vaultDir).catch(() => {
    throw new Error('AI 知識庫目錄不存在');
  });
  const scriptCandidate = assertInsideRoot(root, path.join(root, 'scripts', 'query_knowledge.py'));
  const indexCandidate = assertInsideRoot(root, path.join(root, 'state', 'knowledge-search-index.json'));
  const [script, index] = await Promise.all([
    realpath(scriptCandidate),
    realpath(indexCandidate),
  ]).catch(() => {
    throw new Error('AI 知識索引尚未建立');
  });
  assertInsideRoot(root, script);
  assertInsideRoot(root, index);
  const indexStat = await stat(index);
  if (!indexStat.isFile() || indexStat.size <= 0 || indexStat.size > KNOWLEDGE_INDEX_MAX_BYTES) {
    throw new Error('AI 知識索引大小不符合安全限制');
  }
  return { root, script, index };
}

export async function queryKnowledgeIndex(
  question: string,
  limit: number,
): Promise<KnowledgeSearchPayload> {
  const { script, index } = await resolveKnowledgeFiles();
  try {
    const result = await execFileAsync(
      config.knowledgePilot.pythonPath,
      [script, question, '--limit', String(limit), '--json', '--index-path', index],
      {
        timeout: DEFAULT_TIMEOUT_MS,
        maxBuffer: KNOWLEDGE_PILOT_MAX_OUTPUT_BYTES,
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    return parseKnowledgeSearchOutput(result.stdout);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('知識索引')) throw error;
    throw new Error('AI 知識索引查詢失敗');
  }
}

export function formatKnowledgeAnswer(
  question: string,
  results: KnowledgeSearchHit[],
): { answer: string; citations: KnowledgeCitation[] } {
  if (results.length === 0) {
    return {
      answer: `目前知識庫找不到足夠相關的資料來回答「${clampText(question, 120)}」。我不會用未收錄內容補造答案；可以換一組關鍵字，或先把新來源收錄進知識庫。`,
      citations: [],
    };
  }

  const citations = results.map<KnowledgeCitation>((hit, index) => ({
    id: index + 1,
    title: hit.title,
    channel: hit.channel,
    label: hit.evidence_label ?? null,
    excerpt: clampText(hit.evidence_text, 420),
    timestamp: hit.timestamp,
    url: hit.evidence_url,
    wikiSource: hit.wiki_source ?? null,
    matchedTools: hit.matched_tools,
    score: hit.score,
  }));

  const lines = [
    `已從 LazyOffice AI 知識庫找到 ${citations.length} 筆可追溯證據。以下內容是依命中證據整理，不包含即時網路資料：`,
    '',
  ];
  for (const citation of citations) {
    const tool = citation.matchedTools.length > 0
      ? `（${citation.matchedTools.join('、')}）`
      : '';
    lines.push(
      `${citation.id}. ${citation.title}${tool}`,
      `   ${citation.excerpt} [${citation.id}]`,
    );
  }
  lines.push('', '若要做採購或正式技術決策，建議再開啟引用核對原片上下文。');
  return deepRedactSecrets({ answer: lines.join('\n'), citations });
}

async function persistKnowledgePilotRecord(record: KnowledgePilotRecord): Promise<void> {
  await mkdir(paths.knowledgePilotRuns, { recursive: true });
  const filename = `${record.id}.json`;
  const target = safeJoin(paths.knowledgePilotRuns, filename);
  const temporary = safeJoin(paths.knowledgePilotRuns, `${record.id}.tmp`);
  const redacted = deepRedactSecrets(record);
  await writeFile(temporary, `${JSON.stringify(redacted, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporary, target);
}

async function auditKnowledgePilotRecord(
  record: KnowledgePilotRecord,
  actorId: string,
): Promise<void> {
  await writeAudit(actorId, 'knowledge_pilot.query', 'KnowledgePilotRun', record.id, {
    status: record.status,
    flowId: record.flowId,
    questionHash: createHash('sha256').update(record.question, 'utf8').digest('hex'),
    citationCount: record.citations.length,
    durationMs: record.durationMs,
  });
}

function elapsed(now: () => Date, started: Date): number {
  return Math.max(0, now().getTime() - started.getTime());
}

function hasSuccessfulLangflowProof(events: NormalizedRunEvent[], runId: string): boolean {
  const output = events.find((event) => event.type === 'run.output');
  const finished = events.find(
    (event) => event.type === 'run.finished' && event.status === 'SUCCEEDED',
  );
  if (!output || output.type !== 'run.output' || !finished) return false;
  return JSON.stringify(output.output).includes(runId);
}

export async function runKnowledgePilot(
  input: { question: string; limit: number; actorId: string },
  deps: KnowledgePilotDeps = {},
): Promise<KnowledgePilotRecord> {
  const now = deps.now ?? (() => new Date());
  const search = deps.search ?? queryKnowledgeIndex;
  const runtime = deps.runtime ?? resolveRuntimeAdapter('LANGFLOW', 'SANDBOX');
  const persist = deps.persist ?? persistKnowledgePilotRecord;
  const audit = deps.audit ?? auditKnowledgePilotRecord;
  const started = now();
  const runId = `ksp_${ulid()}`;
  const question = redactSecrets(input.question.trim());
  const trace: KnowledgePilotTraceStep[] = [];
  let answer = '';
  let citations: KnowledgeCitation[] = [];
  let activeStep: KnowledgePilotTraceStep['key'] = 'validate_input';
  let stepStarted = now();

  const pushSuccess = (
    key: KnowledgePilotTraceStep['key'],
    label: string,
    detail: string,
  ) => {
    trace.push({ key, label, status: 'SUCCEEDED', durationMs: elapsed(now, stepStarted), detail });
    stepStarted = now();
  };

  try {
    if (question.length < 2 || question.length > KNOWLEDGE_PILOT_MAX_QUESTION) {
      throw new Error(`問題長度必須介於 2 到 ${KNOWLEDGE_PILOT_MAX_QUESTION} 個字元`);
    }
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 6) {
      throw new Error('引用筆數必須介於 1 到 6');
    }
    pushSuccess('validate_input', '檢查輸入與權限', '輸入已通過長度與唯讀邊界檢查');

    activeStep = 'query_index';
    const searchResult = await search(question, input.limit);
    pushSuccess('query_index', '查詢 AI 知識索引', `命中 ${searchResult.results.length} 筆已收錄來源`);

    activeStep = 'evidence_gate';
    ({ answer, citations } = formatKnowledgeAnswer(question, searchResult.results));
    pushSuccess(
      'evidence_gate',
      '建立證據與引用',
      citations.length > 0 ? `保留 ${citations.length} 筆原片時間碼` : '證據不足，回傳知識缺口',
    );

    activeStep = 'langflow_sandbox';
    const health = await runtime.health();
    if (!health.healthy) {
      throw new Error('Langflow Sandbox 目前無法連線');
    }
    const events: NormalizedRunEvent[] = [];
    for await (const event of runtime.execute({
      runId,
      agentId: 'shadow-ai-knowledge-collector',
      artifactId: config.knowledgePilot.flowId,
      input: {
        schema: 'lazyoffice.knowledge-pilot.v1',
        runId,
        question,
        answer,
        citations,
      },
      triggeredBy: input.actorId,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    })) {
      events.push(event);
      if (event.type === 'run.error') throw new Error(event.message);
    }
    if (!hasSuccessfulLangflowProof(events, runId)) {
      throw new Error('Langflow 沒有回傳本次執行識別，已拒絕假成功');
    }
    pushSuccess(
      'langflow_sandbox',
      'Langflow Sandbox 執行',
      `Flow ${config.knowledgePilot.flowId} 已回傳本次 run marker`,
    );

    activeStep = 'persist_trace';
    trace.push({
      key: 'persist_trace',
      label: '保存執行紀錄',
      status: 'SUCCEEDED',
      durationMs: 0,
      detail: '保存前已套用 secrets redaction；不保存 Langflow credential',
    });
    const finished = now();
    const record = deepRedactSecrets<KnowledgePilotRecord>({
      id: runId,
      flowId: config.knowledgePilot.flowId,
      flowName: KNOWLEDGE_PILOT_FLOW_NAME,
      environment: 'SANDBOX',
      runtimeKind: 'LANGFLOW',
      status: 'SUCCEEDED',
      question,
      answer,
      citations,
      trace,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: Math.max(0, finished.getTime() - started.getTime()),
      error: null,
    });
    try {
      await persist(record);
    } catch {
      record.trace[record.trace.length - 1] = {
        ...record.trace[record.trace.length - 1]!,
        status: 'NON_BLOCKING_FAILURE',
        detail: '執行成功，但本地紀錄寫入失敗（不影響唯讀查詢結果）',
      };
    }
    try {
      await audit(record, input.actorId);
    } catch {
      // Audit helper is fail-safe by contract; injected implementations remain non-blocking.
    }
    return record;
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : 'Sandbox 執行失敗');
    trace.push({
      key: activeStep,
      label: activeStep === 'langflow_sandbox' ? 'Langflow Sandbox 執行' : 'Sandbox 執行',
      status: 'FAILED',
      durationMs: elapsed(now, stepStarted),
      detail: message,
    });
    const finished = now();
    const record = deepRedactSecrets<KnowledgePilotRecord>({
      id: runId,
      flowId: config.knowledgePilot.flowId,
      flowName: KNOWLEDGE_PILOT_FLOW_NAME,
      environment: 'SANDBOX',
      runtimeKind: 'LANGFLOW',
      status: 'FAILED',
      question,
      answer,
      citations,
      trace,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: Math.max(0, finished.getTime() - started.getTime()),
      error: message,
    });
    try { await persist(record); } catch { /* fail-safe trace */ }
    try { await audit(record, input.actorId); } catch { /* fail-safe audit */ }
    throw new KnowledgePilotRunError(message, record);
  }
}

export async function listKnowledgePilotRuns(limit = 20): Promise<KnowledgePilotRecord[]> {
  await mkdir(paths.knowledgePilotRuns, { recursive: true });
  const files = (await readdir(paths.knowledgePilotRuns))
    .filter((name) => /^ksp_[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(name))
    .sort()
    .reverse()
    .slice(0, Math.max(1, Math.min(limit, 50)));
  const records: KnowledgePilotRecord[] = [];
  for (const filename of files) {
    try {
      const target = safeJoin(paths.knowledgePilotRuns, filename);
      const parsed = JSON.parse(await readFile(target, 'utf8')) as KnowledgePilotRecord;
      if (parsed?.id && (parsed.status === 'SUCCEEDED' || parsed.status === 'FAILED')) {
        records.push(deepRedactSecrets(parsed));
      }
    } catch {
      // One corrupt auxiliary trace must not hide other records.
    }
  }
  return records;
}

export async function getKnowledgePilotStatus(): Promise<{
  flowId: string;
  flowName: string;
  environment: 'SANDBOX';
  productionActivated: false;
  knowledgeIndex: { ready: boolean; documentCount: number; generatedAt: string | null; detail: string };
  langflow: { healthy: boolean; latencyMs: number | null; detail: string | null };
  latestRun: KnowledgePilotRecord | null;
}> {
  let knowledgeIndex = {
    ready: false,
    documentCount: 0,
    generatedAt: null as string | null,
    detail: '索引尚未建立',
  };
  try {
    const { index } = await resolveKnowledgeFiles();
    const parsed = JSON.parse(await readFile(index, 'utf8')) as {
      generated_at?: unknown;
      documents?: unknown;
    };
    const documentCount = Array.isArray(parsed.documents) ? parsed.documents.length : 0;
    knowledgeIndex = {
      ready: documentCount > 0,
      documentCount,
      generatedAt: typeof parsed.generated_at === 'string' ? parsed.generated_at : null,
      detail: documentCount > 0 ? '唯讀本地索引可用' : '索引沒有可查詢文件',
    };
  } catch (error) {
    knowledgeIndex.detail = redactSecrets(error instanceof Error ? error.message : '索引檢查失敗');
  }

  let langflow = { healthy: false, latencyMs: null as number | null, detail: '尚未檢查' as string | null };
  try {
    const health = await resolveRuntimeAdapter('LANGFLOW', 'SANDBOX').health();
    langflow = { healthy: health.healthy, latencyMs: health.latencyMs, detail: health.detail };
  } catch (error) {
    langflow.detail = redactSecrets(error instanceof Error ? error.message : 'Langflow 設定不可用');
  }
  const latestRun = (await listKnowledgePilotRuns(1))[0] ?? null;
  return deepRedactSecrets({
    flowId: config.knowledgePilot.flowId,
    flowName: KNOWLEDGE_PILOT_FLOW_NAME,
    environment: 'SANDBOX' as const,
    productionActivated: false as const,
    knowledgeIndex,
    langflow,
    latestRun,
  });
}
