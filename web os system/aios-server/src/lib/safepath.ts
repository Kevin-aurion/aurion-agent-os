/**
 * Shared path-guard utilities.
 * Canonical check matches memoryService.readWikiFile:
 * resolve, then `resolved === root || resolved.startsWith(root + path.sep)`.
 */
import path from 'node:path';

/** Reserved / separator / control chars stripped from a single path segment. */
const UNSAFE_SEGMENT_CHARS = /[\\/:*?"<>|\x00-\x1f\x7f]/g;

/** Pure-dot segments ('.', '..', '...', etc.) are illegal. */
const PURE_DOTS = /^\.+$/;

/**
 * Sanitize a single path segment: remove path separators and reserved chars.
 * Pure-dot segments ('.' / '..' / '...') are illegal → return fallback.
 */
export function sanitizeSegment(seg: string, fallback = ''): string {
  const cleaned = String(seg ?? '').replace(UNSAFE_SEGMENT_CHARS, '');
  if (!cleaned || PURE_DOTS.test(cleaned)) {
    return fallback;
  }
  return cleaned;
}

/**
 * Resolve and assert that candidate is inside root (including root itself).
 * Throws Error if outside. Returns the resolved absolute path.
 */
export function assertInsideRoot(root: string, candidate: string): string {
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error(`path escapes root: ${candidate}`);
  }
  return resolved;
}

/**
 * Safe join: sanitize each part, join onto root, then assertInsideRoot.
 */
export function safeJoin(root: string, ...parts: string[]): string {
  const cleaned = parts.map((p) => sanitizeSegment(p));
  const joined = path.join(root, ...cleaned);
  return assertInsideRoot(root, joined);
}

/**
 * Non-throwing check: whether candidate resolves inside root.
 */
export function isInsideRoot(root: string, candidate: string): boolean {
  try {
    assertInsideRoot(root, candidate);
    return true;
  } catch {
    return false;
  }
}
