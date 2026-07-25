/**
 * CJK-friendly slugify shared across agents / skills / workflows.
 * Keeps CJK scripts, lowercases ASCII alphanumerics, maps other chars to '-',
 * collapses dashes, trims, caps length at 48. Never returns empty.
 */
import { createHash } from 'node:crypto';

/** Max slug length (matches historical callers' intent). */
const MAX_LEN = 48;

/**
 * Allowed: a-z 0-9 + CJK ranges:
 * - ぁ-ゟ / ゠-ヿ (U+3040–30FF, Japanese kana incl. punctuation block used in practice as ぁ–ヿ)
 * - 㐀-䶿 (U+3400–4DBF, CJK Ext. A)
 * - 一-鿿 (U+4E00–9FFF, CJK Unified)
 * - 豈-﫿 (U+F900–FAFF, CJK Compatibility Ideographs)
 * - 가-힯 (U+AC00–D7A3, Hangul syllables)
 */
const KEEP =
  /[^\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7a3a-z0-9]+/g;

/**
 * CJK-friendly slug: keep CJK, lowercase alphanumerics, other → '-',
 * collapse consecutive '-', strip leading/trailing '-', max length 48.
 * If empty after that → 'x-' + sha256(original).slice(0, 8) (stable, non-empty).
 */
export function slugify(name: string): string {
  const input = String(name ?? '');
  let s = input
    .toLowerCase()
    .trim()
    .replace(KEEP, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (s.length > MAX_LEN) {
    s = s.slice(0, MAX_LEN).replace(/-+$/g, '');
  }

  if (!s) {
    const hash = createHash('sha256').update(input).digest('hex').slice(0, 8);
    return `x-${hash}`;
  }
  return s;
}
