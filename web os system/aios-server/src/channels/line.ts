// LINE Messaging API channel adapter.
// Env: LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET (see src/config.ts -> config.line)
// Webhook URL (once wired by routes.ts): POST /webhook/line
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { prisma } from '../lib/db.js';
import type { ChannelAdapter } from './types.js';

const LINE_API = 'https://api.line.me/v2/bot';

// LINE caps a single text message at 5000 chars; keep a safety margin.
function clamp(text: string, max = 4900): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/**
 * Verify a LINE webhook signature: HMAC-SHA256 over the RAW request body
 * using the channel secret, base64-encoded, compared in constant time
 * against the X-Line-Signature header.
 */
export function verifySignature(rawBody: Buffer | string, signatureHeader: string | undefined | null): boolean {
  if (!signatureHeader) return false;
  const secret = config.line.channelSecret;
  if (!secret) return false;
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const expected = createHmac('sha256', secret).update(body).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Push a message to a LINE userId or groupId/roomId (both work with the
 * push endpoint — the reference implementation only targeted userId).
 */
export async function pushMessage(to: string, text: string): Promise<void> {
  const token = config.line.accessToken;
  if (!token) {
    console.log(`[line] (no access token configured, skipping push) -> ${text.slice(0, 60)}...`);
    return;
  }
  const res = await fetch(`${LINE_API}/message/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to, messages: [{ type: 'text', text: clamp(text) }] }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[line] push failed ${res.status}: ${body}`);
  }
}

/** Reply using a one-time, short-lived reply token from a webhook event. */
export async function replyMessage(replyToken: string, text: string): Promise<void> {
  const token = config.line.accessToken;
  if (!token) {
    console.log(`[line] (no access token configured, skipping reply) -> ${text.slice(0, 60)}...`);
    return;
  }
  if (!replyToken) return;
  const res = await fetch(`${LINE_API}/message/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: clamp(text) }] }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[line] reply failed ${res.status}: ${body}`);
  }
}

/** Push a message to whatever externalId a ChannelBinding points at. */
export async function pushToBinding(bindingId: string, text: string): Promise<void> {
  const binding = await prisma.channelBinding.findUnique({ where: { id: bindingId } });
  if (!binding) {
    console.error(`[line] pushToBinding: no such binding ${bindingId}`);
    return;
  }
  await pushMessage(binding.externalId, text);
}

export type LineSourceType = 'user' | 'group' | 'room';

export interface LineParsedEvent {
  type: string;
  sourceType: LineSourceType | null;
  sourceId: string | null;
  bindingId: string | null;
  isTextMessage: boolean;
  text: string | null;
  replyToken: string | null;
  raw: any;
}

/**
 * Verify + parse a LINE webhook payload. For message events coming from a
 * user/group that has no matching ChannelBinding yet, auto-reply with the
 * raw source id so the owner can self-service label it into a binding
 * (mirrors the bindings.json onboarding flow from the reference gateway).
 * Returns the parsed events (bound or not) for the caller (routes.ts) to
 * route into agents/workflows.
 */
export async function handleWebhook(rawBody: Buffer | string, signature: string | undefined | null): Promise<LineParsedEvent[]> {
  if (!verifySignature(rawBody, signature)) {
    throw new Error('invalid LINE signature');
  }
  const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  let payload: any = {};
  try {
    payload = bodyStr ? JSON.parse(bodyStr) : {};
  } catch {
    throw new Error('invalid JSON body');
  }

  const events: any[] = Array.isArray(payload.events) ? payload.events : [];
  const parsed: LineParsedEvent[] = [];

  for (const ev of events) {
    const sourceType: LineSourceType | null = ev.source?.type ?? null;
    const sourceId: string | null = ev.source?.userId ?? ev.source?.groupId ?? ev.source?.roomId ?? null;
    const isTextMessage = ev.type === 'message' && ev.message?.type === 'text';
    const text: string | null = isTextMessage ? ev.message.text ?? null : null;
    const replyToken: string | null = ev.replyToken ?? null;

    let bindingId: string | null = null;
    if (sourceId) {
      const binding = await prisma.channelBinding.findUnique({
        where: { channel_externalId: { channel: 'LINE', externalId: sourceId } },
      });
      bindingId = binding?.id ?? null;
    }

    // Self-service onboarding: unbound user/group sources get their raw id
    // echoed back so the owner can create a ChannelBinding for them.
    if (!bindingId && sourceId && (sourceType === 'user' || sourceType === 'group' || sourceType === 'room') && replyToken) {
      await replyMessage(
        replyToken,
        `This ${sourceType} is not yet linked. Its id is:\n${sourceId}\nAsk an admin to add it as a channel binding.`,
      );
    }

    parsed.push({ type: ev.type, sourceType, sourceId, bindingId, isTextMessage, text, replyToken, raw: ev });
  }

  return parsed;
}

/** ChannelAdapter implementation for LINE, driven by config.line. */
export const lineAdapter: ChannelAdapter = {
  channel: 'LINE',
  configured(): boolean {
    return Boolean(config.line.accessToken && config.line.channelSecret);
  },
  async handleHttp(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const signature = (req.headers['x-line-signature'] as string | undefined) ?? undefined;
    const raw: Buffer | string = (req as any).rawBody ?? JSON.stringify(req.body ?? {});
    try {
      const events = await handleWebhook(raw, signature);
      reply.code(200).send({ success: true, data: { events: events.length } });
    } catch (e) {
      reply.code(403).send({ success: false, error: { code: 'INVALID_SIGNATURE', message: e instanceof Error ? e.message : String(e) } });
    }
  },
};
