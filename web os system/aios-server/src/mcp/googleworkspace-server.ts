#!/usr/bin/env node
// Internal Google Workspace MCP subprocess (newline-delimited JSON-RPC).
// It never receives OAuth tokens: it uses the configured ConnectedAccount id
// and requires a short-lived capability signed by the AIOS broker per call.
import readline from 'node:readline';
import { z } from 'zod';
import * as cloud from '../integrations/cloud.js';
import { prisma } from '../lib/db.js';
import { verifyMcpCapability } from '../lib/mcpcapability.js';

const argv = process.argv.slice(2);
function arg(name: string): string {
  const i = argv.indexOf(name);
  const value = i >= 0 ? argv[i + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const accountId = arg('--account-id');
const serverId = arg('--server-id');
const maxChars = z.number().int().min(1_000).max(100_000).optional();
const usedCapabilities = new Set<string>();

const tools = [
  {
    name: 'gmail_search',
    description: 'Search Gmail metadata and snippets. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: 500 } },
      additionalProperties: false,
    },
  },
  {
    name: 'gmail_get_message',
    description: 'Read one Gmail message body and attachment names. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { messageId: { type: 'string' }, maxChars: { type: 'integer', minimum: 1000, maximum: 100000 } },
      required: ['messageId'],
      additionalProperties: false,
    },
  },
  {
    name: 'drive_search',
    description: 'Search Google Drive names/full text. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: 500 }, limit: { type: 'integer', minimum: 1, maximum: 50 } },
      additionalProperties: false,
    },
  },
  {
    name: 'drive_read_text',
    description: 'Read a text, Google Docs, or Google Sheets file. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { fileId: { type: 'string' }, maxChars: { type: 'integer', minimum: 1000, maximum: 100000 } },
      required: ['fileId'],
      additionalProperties: false,
    },
  },
  {
    name: 'gmail_create_draft',
    description: 'Create but do not send a Gmail draft. Requires approved run + cloudWrite at the broker.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', format: 'email' }, cc: { type: 'string', format: 'email' },
        subject: { type: 'string' }, body: { type: 'string' }, runId: { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'gmail_send',
    description: 'Send one Gmail message. Requires approved run + sendEmail at the broker.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string', format: 'email' }, subject: { type: 'string' }, body: { type: 'string' }, runId: { type: 'string' } },
      required: ['to', 'subject', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'drive_create_text_file',
    description: 'Create one UTF-8 text/Markdown Drive file. Requires approved run + cloudWrite at the broker.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, content: { type: 'string' }, folderId: { type: 'string' },
        mimeType: { type: 'string', enum: ['text/plain', 'text/markdown'] }, runId: { type: 'string' },
      },
      required: ['name', 'content'],
      additionalProperties: false,
    },
  },
] as const;

async function assertAccount(): Promise<void> {
  const account = await prisma.connectedAccount.findFirst({
    where: { id: accountId, provider: 'GOOGLE', status: 'CONNECTED' },
    select: { id: true },
  });
  if (!account) throw new Error('Google Workspace account is not connected');
}

async function callTool(name: string, raw: Record<string, unknown>): Promise<unknown> {
  const capability = String(raw.__aiosCapability ?? '');
  const proof = verifyMcpCapability(capability, { serverId, tool: name });
  if (usedCapabilities.has(proof.jti)) throw new Error('MCP capability already used');
  usedCapabilities.add(proof.jti);
  // Bound memory to the capability lifetime; the token can never become valid again.
  setTimeout(() => usedCapabilities.delete(proof.jti), 60_000).unref?.();
  const args = { ...raw };
  delete args.__aiosCapability;
  await assertAccount();

  switch (name) {
    case 'gmail_search': {
      const p = z.object({ query: z.string().max(500).optional() }).parse(args);
      return cloud.listMessages(accountId, p.query);
    }
    case 'gmail_get_message': {
      const p = z.object({ messageId: z.string().min(1), maxChars }).parse(args);
      return cloud.getGoogleMessage(accountId, p.messageId, p.maxChars);
    }
    case 'drive_search': {
      const p = z.object({ query: z.string().max(500).default(''), limit: z.number().int().min(1).max(50).optional() }).parse(args);
      return cloud.searchGoogleDrive(accountId, p.query, p.limit);
    }
    case 'drive_read_text': {
      const p = z.object({ fileId: z.string().min(1), maxChars }).parse(args);
      return cloud.readGoogleDriveText(accountId, p.fileId, p.maxChars);
    }
    case 'gmail_create_draft': {
      const p = z.object({
        to: z.string().email(), cc: z.string().email().optional(), subject: z.string().min(1).max(500),
        body: z.string().min(1).max(500_000), runId: z.string().optional(),
      }).parse(args);
      if (!proof.runId || (p.runId && p.runId !== proof.runId)) throw new Error('approved run capability required');
      return cloud.createGoogleMailDraft(accountId, p);
    }
    case 'gmail_send': {
      const p = z.object({
        to: z.string().email(), subject: z.string().min(1).max(500), body: z.string().min(1).max(500_000),
        runId: z.string().optional(),
      }).parse(args);
      if (!proof.runId || (p.runId && p.runId !== proof.runId)) throw new Error('approved run capability required');
      return cloud.sendMail(accountId, p);
    }
    case 'drive_create_text_file': {
      const p = z.object({
        name: z.string().min(1).max(240), content: z.string().max(2_000_000), folderId: z.string().optional(),
        mimeType: z.enum(['text/plain', 'text/markdown']).optional(), runId: z.string().optional(),
      }).parse(args);
      if (!proof.runId || (p.runId && p.runId !== proof.runId)) throw new Error('approved run capability required');
      return cloud.createGoogleDriveTextFile(accountId, p);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let req: { id?: string | number; method?: string; params?: Record<string, unknown> };
  try {
    req = JSON.parse(line) as typeof req;
  } catch {
    return;
  }
  if (req.id == null) return;
  try {
    if (req.method === 'initialize') {
      await assertAccount();
      send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'aios-google-workspace', version: '1.0.0' } } });
      return;
    }
    if (req.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: req.id, result: { tools } });
      return;
    }
    if (req.method === 'tools/call') {
      const name = String(req.params?.name ?? '');
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      const result = await callTool(name, args);
      send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
      return;
    }
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } });
  } catch (e) {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        isError: true,
        content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
      },
    });
  }
});

rl.on('close', () => {
  void prisma.$disconnect().finally(() => process.exit(0));
});
