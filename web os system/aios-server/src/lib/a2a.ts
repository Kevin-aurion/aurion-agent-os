// Opt-in A2A task gateway to FDE-approved external peers.
// DISABLED by default (enabled=false ⇒ submit rejected). Fail-closed on doubt.
// External peers are NEVER policy authorities — local gates decide first.
import { ulid } from 'ulid';
import type { A2APeer, A2ATask, Prisma } from '@prisma/client';
import { audit } from './audit.js';
import { prisma } from './db.js';
import { errors } from './http.js';
import { redactSecrets } from '../memory/redactor.js';
import { allowWrite, assertWriteEnabled } from './stopwrite.js';

const CRED_REF_RE = /^(env:[A-Za-z_][A-Za-z0-9_]*|keychain:[^\s]+)$/;
const SUMMARY_CAP = 2000;

export type A2APeerDto = {
  id: string;
  peerId: string;
  name: string;
  description: string;
  baseUrl: string;
  enabled: boolean;
  credentialRef: string | null;
  riskTier: string;
  maxPayloadBytes: number;
  timeoutMs: number;
  approvedBy: string | null;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type A2ATaskDto = {
  id: string;
  peerId: string;
  agentId: string | null;
  remoteTaskId: string | null;
  status: string;
  requestSummary: unknown;
  responseSummary: unknown;
  submittedBy: string;
  createdAt: Date;
  updatedAt: Date;
};

export type RegisterPeerInput = {
  peerId: string;
  name: string;
  description?: string;
  baseUrl: string;
  credentialRef?: string | null;
  riskTier?: string;
  maxPayloadBytes?: number;
  timeoutMs?: number;
  enabled?: boolean;
};

function isCredentialRef(ref: string): boolean {
  if (typeof ref !== 'string' || !ref) return false;
  if (!CRED_REF_RE.test(ref)) return false;
  return redactSecrets(ref) === ref;
}

/**
 * Resolve env:NAME → process.env[NAME]. Never logs the value.
 * keychain:… is a documented no-op placeholder (returns undefined).
 */
function resolveCredential(ref: string | null | undefined): string | undefined {
  if (!ref) return undefined;
  if (!isCredentialRef(ref)) return undefined;
  if (ref.startsWith('env:')) {
    const name = ref.slice(4);
    const v = process.env[name];
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

function assertHttpUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw errors.badRequest('baseUrl must be a valid http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw errors.badRequest('baseUrl must be http or https');
  }
  return parsed;
}

function redactedJsonSummary(value: unknown, cap = SUMMARY_CAP): Prisma.InputJsonValue {
  let raw: string;
  try {
    raw = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    raw = String(value);
  }
  const redacted = redactSecrets(raw).slice(0, cap);
  try {
    return JSON.parse(redacted) as Prisma.InputJsonValue;
  } catch {
    return { summary: redacted } as Prisma.InputJsonValue;
  }
}

/** Safe DTO — never resolves credentials; credentialRef is a reference string only. */
export function toPeerDto(p: A2APeer): A2APeerDto {
  const raw: A2APeerDto = {
    id: p.id,
    peerId: p.peerId,
    name: p.name,
    description: p.description,
    baseUrl: p.baseUrl,
    enabled: p.enabled,
    credentialRef: p.credentialRef,
    riskTier: p.riskTier,
    maxPayloadBytes: p.maxPayloadBytes,
    timeoutMs: p.timeoutMs,
    approvedBy: p.approvedBy,
    approvedAt: p.approvedAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
  try {
    return JSON.parse(redactSecrets(JSON.stringify(raw))) as A2APeerDto;
  } catch {
    return raw;
  }
}

export function toTaskDto(t: A2ATask): A2ATaskDto {
  const raw: A2ATaskDto = {
    id: t.id,
    peerId: t.peerId,
    agentId: t.agentId,
    remoteTaskId: t.remoteTaskId,
    status: t.status,
    requestSummary: t.requestSummary,
    responseSummary: t.responseSummary,
    submittedBy: t.submittedBy,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
  try {
    return JSON.parse(redactSecrets(JSON.stringify(raw))) as A2ATaskDto;
  } catch {
    return raw;
  }
}

export async function registerPeer(
  input: RegisterPeerInput,
  fdeUserId: string,
): Promise<A2APeerDto> {
  assertWriteEnabled('a2a');
  if (!input.peerId?.trim()) throw errors.badRequest('peerId is required');
  if (!input.name?.trim()) throw errors.badRequest('name is required');
  assertHttpUrl(input.baseUrl);

  if (input.credentialRef != null && input.credentialRef !== '') {
    if (!isCredentialRef(input.credentialRef)) {
      throw errors.badRequest(
        'credentialRef must be an env:NAME or keychain:… reference (plaintext secrets rejected)',
      );
    }
  }

  const riskTier = input.riskTier ?? 'high';
  if (!['low', 'medium', 'high'].includes(riskTier)) {
    throw errors.badRequest('riskTier must be low|medium|high');
  }
  if (
    input.maxPayloadBytes !== undefined &&
    (!Number.isFinite(input.maxPayloadBytes) || input.maxPayloadBytes <= 0)
  ) {
    throw errors.badRequest('maxPayloadBytes must be a positive number');
  }
  if (
    input.timeoutMs !== undefined &&
    (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)
  ) {
    throw errors.badRequest('timeoutMs must be a positive number');
  }

  const id = ulid();
  const now = new Date();
  const row = await prisma.a2APeer.create({
    data: {
      id,
      peerId: input.peerId.trim(),
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      baseUrl: input.baseUrl.trim(),
      enabled: input.enabled ?? false,
      credentialRef: input.credentialRef?.trim() || null,
      riskTier,
      maxPayloadBytes: input.maxPayloadBytes ?? 65536,
      timeoutMs: input.timeoutMs ?? 30000,
      approvedBy: fdeUserId,
      approvedAt: now,
    },
  });
  return toPeerDto(row);
}

export async function setPeerEnabled(
  peerId: string,
  enabled: boolean,
  fdeUserId: string,
): Promise<A2APeerDto> {
  assertWriteEnabled('a2a');
  const peer = await prisma.a2APeer.findFirst({
    where: { OR: [{ id: peerId }, { peerId }] },
  });
  if (!peer) throw errors.notFound('a2a peer not found');
  const row = await prisma.a2APeer.update({
    where: { id: peer.id },
    data: {
      enabled: !!enabled,
      approvedBy: fdeUserId,
      approvedAt: new Date(),
    },
  });
  return toPeerDto(row);
}

export async function deletePeer(peerId: string): Promise<void> {
  assertWriteEnabled('a2a');
  const peer = await prisma.a2APeer.findFirst({
    where: { OR: [{ id: peerId }, { peerId }] },
  });
  if (!peer) throw errors.notFound('a2a peer not found');
  await prisma.a2APeer.delete({ where: { id: peer.id } });
}

export async function listPeers(): Promise<A2APeerDto[]> {
  const rows = await prisma.a2APeer.findMany({ orderBy: { createdAt: 'desc' } });
  return rows.map(toPeerDto);
}

export async function getPeer(peerId: string): Promise<A2APeer | null> {
  return prisma.a2APeer.findFirst({
    where: { OR: [{ id: peerId }, { peerId }] },
  });
}

/**
 * Discovery / card fetch from peer.baseUrl.
 * Card fetch is allowed when the peer exists (read-only discovery),
 * even if enabled=false — it does not delegate work. Submit remains gated.
 */
export async function fetchPeerCard(peerId: string): Promise<unknown> {
  const peer = await getPeer(peerId);
  if (!peer) throw errors.notFound('a2a peer not found');
  assertHttpUrl(peer.baseUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), peer.timeoutMs);
  try {
    const cardUrl = peer.baseUrl.replace(/\/$/, '') + '/card';
    const headers: Record<string, string> = { Accept: 'application/json' };
    const cred = resolveCredential(peer.credentialRef);
    if (cred) headers.Authorization = `Bearer ${cred}`;

    const res = await fetch(cardUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    const text = await res.text();
    const redacted = redactSecrets(text).slice(0, SUMMARY_CAP);
    try {
      return JSON.parse(redacted);
    } catch {
      return { raw: redacted };
    }
  } catch (e) {
    const msg = redactSecrets(e instanceof Error ? e.message : String(e));
    throw errors.badRequest(`peer card fetch failed: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Governed remote task submit. LOCAL gates first (enabled, payload bound, peer exists).
 * Peer response never relaxes local policy.
 */
export async function submitTask(input: {
  peerId: string;
  agentId?: string;
  payload: unknown;
  submittedBy: string;
}): Promise<A2ATaskDto> {
  assertWriteEnabled('a2a');
  const peer = await getPeer(input.peerId);
  if (!peer) throw errors.notFound('a2a peer not found');

  // Fail-closed: disabled by default ⇒ reject.
  if (!peer.enabled) {
    throw errors.forbidden('遠端委派已停用（peer disabled）');
  }

  let payloadStr: string;
  try {
    payloadStr = JSON.stringify(input.payload ?? null);
  } catch {
    throw errors.badRequest('payload is not JSON-serializable');
  }
  const bytes = Buffer.byteLength(payloadStr, 'utf8');
  if (bytes > peer.maxPayloadBytes) {
    throw errors.badRequest(
      `payload 超出上限 (${bytes} > ${peer.maxPayloadBytes} bytes)`,
    );
  }

  const taskId = ulid();
  const requestSummary = redactedJsonSummary(input.payload);
  let task = await prisma.a2ATask.create({
    data: {
      id: taskId,
      peerId: peer.id,
      agentId: input.agentId ?? null,
      status: 'PENDING',
      requestSummary,
      submittedBy: input.submittedBy,
    },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), peer.timeoutMs);
  try {
    const submitUrl = peer.baseUrl.replace(/\/$/, '') + '/tasks';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    const cred = resolveCredential(peer.credentialRef);
    if (cred) headers.Authorization = `Bearer ${cred}`;

    const res = await fetch(submitUrl, {
      method: 'POST',
      headers,
      body: payloadStr,
      signal: controller.signal,
    });
    const text = await res.text();
    let remoteBody: unknown = text;
    try {
      remoteBody = JSON.parse(text);
    } catch {
      // keep text
    }

    if (!res.ok) {
      const summary = redactedJsonSummary({
        status: res.status,
        body: remoteBody,
      });
      task = await prisma.a2ATask.update({
        where: { id: taskId },
        data: { status: 'FAILED', responseSummary: summary },
      });
      throw errors.badRequest(
        `peer task submit rejected (HTTP ${res.status})`,
      );
    }

    const remoteTaskId =
      remoteBody &&
      typeof remoteBody === 'object' &&
      remoteBody !== null &&
      'id' in remoteBody
        ? String((remoteBody as { id: unknown }).id)
        : remoteBody &&
            typeof remoteBody === 'object' &&
            remoteBody !== null &&
            'taskId' in remoteBody
          ? String((remoteBody as { taskId: unknown }).taskId)
          : null;

    const responseSummary = redactedJsonSummary(remoteBody);
    task = await prisma.a2ATask.update({
      where: { id: taskId },
      data: {
        status: 'SUBMITTED',
        remoteTaskId,
        responseSummary,
      },
    });
  } catch (e) {
    if (e && typeof e === 'object' && 'statusCode' in e) throw e;
    const msg = redactSecrets(e instanceof Error ? e.message : String(e));
    try {
      await prisma.a2ATask.update({
        where: { id: taskId },
        data: {
          status: 'FAILED',
          responseSummary: redactedJsonSummary({ error: msg }),
        },
      });
    } catch {
      // ignore persist failure
    }
    throw errors.badRequest(`peer task submit failed: ${msg}`);
  } finally {
    clearTimeout(timer);
  }

  await audit(input.submittedBy, 'a2a.task.submit', 'A2ATask', task.id, {
    peerId: peer.peerId,
    agentId: input.agentId ?? null,
  });

  return toTaskDto(task);
}

export async function getTaskStatus(taskId: string): Promise<A2ATaskDto> {
  const task = await prisma.a2ATask.findUnique({ where: { id: taskId } });
  if (!task) throw errors.notFound('a2a task not found');

  // S1-6: keep the read path, but skip remote poll updates that write A2ATask.
  if (!allowWrite('a2a')) return toTaskDto(task);

  // Best-effort remote poll when we have a remote id and peer is enabled.
  if (task.remoteTaskId) {
    const peer = await prisma.a2APeer.findUnique({ where: { id: task.peerId } });
    if (peer?.enabled) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), peer.timeoutMs);
      try {
        const statusUrl =
          peer.baseUrl.replace(/\/$/, '') + `/tasks/${encodeURIComponent(task.remoteTaskId)}`;
        const headers: Record<string, string> = { Accept: 'application/json' };
        const cred = resolveCredential(peer.credentialRef);
        if (cred) headers.Authorization = `Bearer ${cred}`;
        const res = await fetch(statusUrl, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
        const text = await res.text();
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          // keep text
        }
        const responseSummary = redactedJsonSummary(body);
        let nextStatus = task.status;
        if (body && typeof body === 'object' && body !== null && 'status' in body) {
          const s = String((body as { status: unknown }).status).toUpperCase();
          if (
            [
              'PENDING',
              'SUBMITTED',
              'RUNNING',
              'SUCCEEDED',
              'FAILED',
              'CANCELLED',
            ].includes(s)
          ) {
            nextStatus = s as typeof task.status;
          }
        }
        const updated = await prisma.a2ATask.update({
          where: { id: task.id },
          data: { status: nextStatus, responseSummary },
        });
        return toTaskDto(updated);
      } catch {
        // fail-safe on status poll — return last known local state
      } finally {
        clearTimeout(timer);
      }
    }
  }

  return toTaskDto(task);
}

export async function cancelTask(
  taskId: string,
  byUser: string,
): Promise<A2ATaskDto> {
  assertWriteEnabled('a2a');
  const task = await prisma.a2ATask.findUnique({ where: { id: taskId } });
  if (!task) throw errors.notFound('a2a task not found');

  if (task.status === 'CANCELLED' || task.status === 'SUCCEEDED' || task.status === 'FAILED') {
    return toTaskDto(task);
  }

  const peer = await prisma.a2APeer.findUnique({ where: { id: task.peerId } });
  if (peer && task.remoteTaskId && peer.enabled) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), peer.timeoutMs);
    try {
      const cancelUrl =
        peer.baseUrl.replace(/\/$/, '') +
        `/tasks/${encodeURIComponent(task.remoteTaskId)}/cancel`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      const cred = resolveCredential(peer.credentialRef);
      if (cred) headers.Authorization = `Bearer ${cred}`;
      await fetch(cancelUrl, {
        method: 'POST',
        headers,
        body: '{}',
        signal: controller.signal,
      });
    } catch {
      // still mark local cancel (local policy wins)
    } finally {
      clearTimeout(timer);
    }
  }

  const updated = await prisma.a2ATask.update({
    where: { id: task.id },
    data: {
      status: 'CANCELLED',
      responseSummary: redactedJsonSummary({ cancelledBy: byUser }),
    },
  });

  await audit(byUser, 'a2a.task.cancel', 'A2ATask', task.id, {
    peerId: task.peerId,
  });

  return toTaskDto(updated);
}
