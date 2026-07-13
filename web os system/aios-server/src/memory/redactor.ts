// Hard redaction of secrets / PII before anything is written to wiki or vectors.
// Always applied — not gated by cloudEmbedding or any user flag.

const PATTERNS: Array<{ re: RegExp; label: string }> = [
  // API keys / bearer tokens
  { re: /\bsk-[A-Za-z0-9_-]{8,}\b/g, label: '[REDACTED_API_KEY]' },
  { re: /\bBearer\s+[A-Za-z0-9._\-+/=]{12,}/gi, label: '[REDACTED_BEARER]' },
  { re: /\b(xox[baprs]-|ghp_|gho_|github_pat_)[A-Za-z0-9_-]{8,}\b/g, label: '[REDACTED_TOKEN]' },
  // Long base64-looking blobs (likely credentials / tokens), length ≥ 40
  { re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, label: '[REDACTED_B64]' },
  // Taiwanese ID-ish patterns (loose): 1 letter + 9 digits
  { re: /\b[A-Z][12]\d{8}\b/g, label: '[REDACTED_ID]' },
  // Credit-card-ish 13–19 digit runs with optional spaces/dashes
  { re: /\b(?:\d[ -]*?){13,19}\b/g, label: '[REDACTED_CARD]' },
  // Email (keep domain structure mild — full address is PII)
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, label: '[REDACTED_EMAIL]' },
];

/** Strip secrets / obvious PII from text before wiki or vector ingest. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { re, label } of PATTERNS) {
    out = out.replace(re, label);
  }
  return out;
}
