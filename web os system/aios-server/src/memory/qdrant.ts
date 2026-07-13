// Qdrant client wrappers for AIOS memory (single collection aios_memory).
// All searches hard-filter on agentId. Point ids are deterministic hashes of
// agentId:path:idx so re-upserts overwrite cleanly.
import { createHash } from 'node:crypto';
import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../config.js';
import { getEmbeddingProvider } from './embedding.js';

export type MemorySourceType = 'wiki' | 'run_summary' | 'chat_summary';

export interface MemoryChunk {
  text: string;
  vector: number[];
}

export interface MemorySearchHit {
  text: string;
  path: string;
  score: number;
  sourceType?: string;
  runId?: string;
}

export interface UpsertExtra {
  runId?: string;
  ts?: string;
}

let client: QdrantClient | null = null;

function getClient(): QdrantClient {
  if (!client) {
    client = new QdrantClient({ url: config.memory.qdrantUrl });
  }
  return client;
}

/** Deterministic UUID-shaped point id from agentId:path:idx. */
export function pointId(agentId: string, path: string, idx: number): string {
  const h = createHash('sha256').update(`${agentId}:${path}:${idx}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Ensure collection exists with provider dimension. Best-effort; throw on hard failure. */
export async function ensureCollection(): Promise<void> {
  if (!config.memory.enabled) return;
  const c = getClient();
  const name = config.memory.collection;
  const dim = getEmbeddingProvider().dimension;
  const collections = await c.getCollections();
  const exists = collections.collections?.some((col) => col.name === name);
  if (exists) return;
  await c.createCollection(name, {
    vectors: { size: dim, distance: 'Cosine' },
  });
  // Payload index for agentId hard filter.
  try {
    await c.createPayloadIndex(name, {
      field_name: 'agentId',
      field_schema: 'keyword',
    });
  } catch {
    // index may already exist after race; ignore
  }
}

export async function upsertChunks(
  agentId: string,
  sourceType: MemorySourceType,
  path: string,
  chunks: MemoryChunk[],
  extra?: UpsertExtra,
): Promise<void> {
  if (!config.memory.enabled || chunks.length === 0) return;
  await ensureCollection();
  const c = getClient();
  const name = config.memory.collection;
  const ts = extra?.ts ?? new Date().toISOString();
  const points = chunks.map((ch, idx) => ({
    id: pointId(agentId, path, idx),
    vector: ch.vector,
    payload: {
      agentId,
      sourceType,
      path,
      runId: extra?.runId ?? null,
      ts,
      text: ch.text,
    },
  }));
  await c.upsert(name, { wait: true, points });
}

/** Delete all points for a given agentId + path (reindex overwrite). */
export async function deletePath(agentId: string, path: string): Promise<void> {
  if (!config.memory.enabled) return;
  const c = getClient();
  const name = config.memory.collection;
  try {
    await c.delete(name, {
      wait: true,
      filter: {
        must: [
          { key: 'agentId', match: { value: agentId } },
          { key: 'path', match: { value: path } },
        ],
      },
    });
  } catch (e: unknown) {
    // Collection missing is fine on first run.
    const msg = e instanceof Error ? e.message : String(e);
    if (!/not found|doesn't exist|404/i.test(msg)) throw e;
  }
}

/** Semantic search hard-filtered to agentId. */
export async function search(
  agentId: string,
  queryVector: number[],
  topK = 4,
): Promise<MemorySearchHit[]> {
  if (!config.memory.enabled) return [];
  await ensureCollection();
  const c = getClient();
  const name = config.memory.collection;
  const res = await c.search(name, {
    vector: queryVector,
    limit: topK,
    with_payload: true,
    filter: {
      must: [{ key: 'agentId', match: { value: agentId } }],
    },
  });
  return (res ?? []).map((hit) => {
    const p = (hit.payload ?? {}) as Record<string, unknown>;
    return {
      text: String(p.text ?? ''),
      path: String(p.path ?? ''),
      score: hit.score ?? 0,
      sourceType: p.sourceType != null ? String(p.sourceType) : undefined,
      runId: p.runId != null ? String(p.runId) : undefined,
    };
  });
}
