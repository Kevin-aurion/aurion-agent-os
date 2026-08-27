// Codex Computer Use + Record & Replay MCP connectors.
// Thin wrappers over the shared mcpclient openSession (one-shot, NOT pooled).
import { config } from '../config.js';
import { openSession, type McpClient } from './mcpclient.js';

export type { McpClient } from './mcpclient.js';

const PERMISSION_HINT =
  '請確認 Codex Computer Use 已安裝、且已授予系統輔助使用權限（系統設定 → 隱私權與安全性 → 輔助使用）。';

/** Connect to Codex Computer Use MCP (10 desktop automation tools). One-shot session. */
export async function connectComputerUse(): Promise<McpClient> {
  return openSession({
    kind: 'stdio',
    command: config.codex.computerUseBin,
    args: ['mcp'],
    cwd: config.codex.computerUseDir,
    label: 'Codex Computer Use',
    errorHint: PERMISSION_HINT,
  });
}

/** Connect to Record & Replay event-stream MCP (start/status/stop). One-shot session. */
export async function connectEventStream(): Promise<McpClient> {
  return openSession({
    kind: 'stdio',
    command: config.codex.recordLauncher,
    args: ['event-stream', 'mcp'],
    cwd: config.codex.recordPluginDir,
    env: { CODEX_HOME: config.codex.home },
    label: 'Record & Replay (event-stream)',
    errorHint: PERMISSION_HINT,
  });
}

/**
 * List tools and ensure every required name is present.
 * Throws a clear error on version drift (missing tools).
 */
export async function assertToolsPresent(c: McpClient, required: string[]): Promise<void> {
  const tools = await c.listTools();
  const have = new Set(tools.map((t) => t.name));
  const missing = required.filter((n) => !have.has(n));
  if (missing.length) {
    throw new Error(
      `MCP 工具清單與預期不符（版本漂移？）缺少: ${missing.join(', ')}。` +
        `實際工具: ${[...have].sort().join(', ') || '(none)'}。${PERMISSION_HINT}`,
    );
  }
}

/** Canonical Computer Use tool set (ADR 0005). */
export const COMPUTER_USE_TOOLS = [
  'list_apps',
  'get_app_state',
  'click',
  'perform_secondary_action',
  'set_value',
  'select_text',
  'scroll',
  'drag',
  'press_key',
  'type_text',
] as const;

/** Canonical Record & Replay tool set (ADR 0005). */
export const EVENT_STREAM_TOOLS = [
  'event_stream_start',
  'event_stream_status',
  'event_stream_stop',
] as const;
