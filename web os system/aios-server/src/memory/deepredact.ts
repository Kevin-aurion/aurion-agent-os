// Recursive redaction for nested JSON / transcript / brief / plan / test evidence.
// Always applied before Agent Builder (and similar) DB persistence — fail-closed on secrets.
import { redactSecrets } from './redactor.js';

const MAX_DEPTH = 32;
const MAX_STRING = 200_000;

/**
 * Recursively apply redactSecrets to every string leaf in a JSON-like value.
 * Objects/arrays are walked; Dates become ISO strings then redacted; functions
 * and symbols are dropped. Caps string length to avoid pathological payloads.
 */
export function deepRedactSecrets<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH) return null as unknown as T;
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    const redacted = redactSecrets(value);
    return (
      redacted.length > MAX_STRING ? redacted.slice(0, MAX_STRING) + '…[truncated]' : redacted
    ) as unknown as T;
  }

  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (value instanceof Date) {
    return redactSecrets(value.toISOString()) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((v) => deepRedactSecrets(v, depth + 1)) as unknown as T;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Drop non-JSON / dangerous keys that might hold raw credentials by convention.
      if (k === 'accessToken' || k === 'refreshToken' || k === 'password' || k === 'passwordHash') {
        out[k] = '[REDACTED]';
        continue;
      }
      if (k === 'accessTokenEnc' || k === 'refreshTokenEnc' || k === 'credential') {
        out[k] = '[REDACTED]';
        continue;
      }
      out[k] = deepRedactSecrets(v, depth + 1);
    }
    return out as unknown as T;
  }

  // functions, symbols, bigint — never persist
  return null as unknown as T;
}
