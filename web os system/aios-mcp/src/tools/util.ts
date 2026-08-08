// Shared helpers for tool handlers: JSON result formatting + error surfacing.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AiosApiError } from '../http/client.js';

export function jsonResult(data: unknown): CallToolResult {
  const structuredContent = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : { result: data };
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent,
  };
}

export function errorResult(err: unknown): CallToolResult {
  let text: string;
  if (err instanceof AiosApiError) {
    text = `aios-server error [${err.code}] (HTTP ${err.status}): ${err.message}`;
    if (err.detail !== undefined) text += `\ndetail: ${JSON.stringify(err.detail, null, 2)}`;
  } else if (err instanceof Error) {
    text = err.message;
  } else {
    text = String(err);
  }
  return { isError: true, content: [{ type: 'text', text }] };
}

/** Run a tool body, mapping thrown aios-server envelope errors to MCP tool errors. */
export async function runTool(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonResult(await fn());
  } catch (err) {
    return errorResult(err);
  }
}
