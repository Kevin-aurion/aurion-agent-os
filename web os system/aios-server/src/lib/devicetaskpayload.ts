/**
 * Strict allowlisted DeviceTask payloads.
 * Server never accepts arbitrary shell/command/executable dispatch.
 */
import { z } from 'zod';
import { errors } from './http.js';
import type { DeviceTaskKind } from '@prisma/client';
import { isLineReadTool, isLineSendTool, isLineTool } from './devicemcp.js';

/** Keys that must never appear anywhere in a task payload (fail-closed). */
const FORBIDDEN_KEYS = new Set([
  'command',
  'shell',
  'executable',
  'exec',
  'bash',
  'cmd',
  'powershell',
  'script',
  'argv',
  'cwd',
  'env',
]);

function assertNoForbiddenKeys(value: unknown, path = ''): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoForbiddenKeys(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lower = k.toLowerCase();
      if (FORBIDDEN_KEYS.has(lower)) {
        throw errors.badRequest(`Forbidden payload field: ${path ? `${path}.` : ''}${k}`);
      }
      // MCP args may have nested objects but never path/command-like keys.
      if (lower === 'path' || lower === 'filepath' || lower === 'filename') {
        throw errors.badRequest(`Forbidden payload field: ${path ? `${path}.` : ''}${k}`);
      }
      assertNoForbiddenKeys(v, path ? `${path}.${k}` : k);
    }
  }
}

const ComputerControlPayload = z
  .object({
    skillId: z.string().min(1).max(128).optional(),
    skillVersionId: z.string().min(1).max(128).optional(),
    instructions: z.string().min(1).max(20_000).optional(),
    app: z.string().min(1).max(256).optional(),
    window: z.string().min(1).max(512).optional(),
    checkpoint: z
      .object({
        requireScreenshot: z.boolean().optional(),
        label: z.string().max(256).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((p) => !!(p.skillId || p.skillVersionId || p.instructions || p.app), {
    message: 'COMPUTER_CONTROL requires skillId, skillVersionId, instructions, or app',
  });

const McpToolPayload = z
  .object({
    serverId: z.string().min(1).max(128),
    tool: z.string().min(1).max(128),
    args: z.record(z.unknown()).optional(),
  })
  .strict();

/**
 * LINE Desktop payload — operation/tool must be semantically consistent (fail-closed).
 * - operation=send: tool REQUIRED and must be an allowlisted send tool
 *   (cannot omit: macOS may default to a send tool, so omission must not skip HITL)
 * - operation=read: tool optional (default read on device) or an allowlisted read tool
 * - reject operation/tool mismatches and any unknown tool
 */
const LineDesktopPayload = z
  .object({
    operation: z.enum(['read', 'send']),
    tool: z.string().min(1).max(128).optional(),
    args: z.record(z.unknown()).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    const tool = typeof p.tool === 'string' ? p.tool.trim() : '';
    if (p.operation === 'send') {
      if (!tool) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'operation=send requires an allowlisted send tool (tool cannot be omitted)',
          path: ['tool'],
        });
        return;
      }
      if (!isLineTool(tool)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown LINE tool: ${tool}`,
          path: ['tool'],
        });
        return;
      }
      if (!isLineSendTool(tool)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `operation=send cannot use read tool: ${tool}`,
          path: ['tool'],
        });
      }
      return;
    }
    // operation === 'read'
    if (!tool) return; // omit = default read on device
    if (!isLineTool(tool)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown LINE tool: ${tool}`,
        path: ['tool'],
      });
      return;
    }
    if (!isLineReadTool(tool)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `operation=read cannot use send tool: ${tool}`,
        path: ['tool'],
      });
    }
  });

const ScreenshotPayload = z
  .object({
    app: z.string().min(1).max(256).optional(),
    window: z.string().min(1).max(512).optional(),
    region: z
      .object({
        x: z.number().int().nonnegative(),
        y: z.number().int().nonnegative(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

const CapabilityProbePayload = z
  .object({
    features: z.array(z.string().min(1).max(64)).max(32).optional(),
  })
  .strict();

/** Server-authored install payload only (no command/url/host). */
const McpInstallPayload = z
  .object({
    mcpKey: z.literal('line-desktop-mcp'),
    packageName: z.literal('line-desktop-mcp'),
    version: z.literal('1.1.2'),
    sha256: z.literal('6f8dff26fe5e13ad886dd04e8e6d9bc788c709e92f85e46b25523c402f20bc7a'),
    toolAllowlist: z.array(z.string()).min(1).max(32),
    transport: z.literal('device-local-stdio'),
  })
  .strict();

/** Kinds that require agentId + AgentDevice binding. */
export const KINDS_REQUIRING_AGENT: ReadonlySet<DeviceTaskKind> = new Set([
  'COMPUTER_CONTROL',
  'MCP_TOOL',
  'LINE_DESKTOP',
]);

/**
 * Validate and return a typed, allowlisted payload for the given kind.
 * Rejects unknown keys and any shell/command-like fields (fail-closed).
 */
export function validateDeviceTaskPayload(
  kind: DeviceTaskKind,
  raw: unknown,
): Record<string, unknown> {
  if (raw === null || raw === undefined) {
    if (kind === 'CAPABILITY_PROBE' || kind === 'SCREENSHOT') {
      return {};
    }
    throw errors.badRequest(`payload required for kind ${kind}`);
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw errors.badRequest('payload must be an object');
  }

  assertNoForbiddenKeys(raw);

  // Explicitly reject network / remote install fields even if nested later.
  const obj = raw as Record<string, unknown>;
  for (const banned of ['url', 'host', 'port', 'baseUrl', 'endpoint', 'command', 'cwd']) {
    if (banned in obj) {
      throw errors.badRequest(`Forbidden payload field: ${banned}`);
    }
  }

  try {
    switch (kind) {
      case 'COMPUTER_CONTROL':
        return ComputerControlPayload.parse(raw);
      case 'MCP_TOOL':
        return McpToolPayload.parse(raw);
      case 'LINE_DESKTOP':
        return LineDesktopPayload.parse(raw);
      case 'SCREENSHOT':
        return ScreenshotPayload.parse(raw);
      case 'CAPABILITY_PROBE':
        return CapabilityProbePayload.parse(raw);
      case 'MCP_INSTALL':
        return McpInstallPayload.parse(raw);
      default:
        throw errors.badRequest(`Unsupported task kind: ${kind}`);
    }
  } catch (e) {
    if (e && typeof e === 'object' && 'name' in e && (e as { name: string }).name === 'ZodError') {
      throw errors.badRequest(`Invalid payload for ${kind}`, e);
    }
    throw e;
  }
}
