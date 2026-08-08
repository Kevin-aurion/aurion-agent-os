// Shared helpers for resource read callbacks.
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { Variables } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';

export function jsonResource(uri: URL, data: unknown): ReadResourceResult {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

export function textResource(uri: URL, text: string, mimeType = 'text/markdown'): ReadResourceResult {
  return { contents: [{ uri: uri.href, mimeType, text }] };
}

/** Extract a single string variable from a ResourceTemplate match. */
export function variable(variables: Variables, name: string): string {
  const value = variables[name];
  const str = Array.isArray(value) ? value.join('/') : value;
  if (!str) throw new Error(`Missing '${name}' in resource URI`);
  return decodeURIComponent(str);
}
