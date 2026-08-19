// Langflow component catalogue helpers (fingerprint + typed lookup).
// Catalogue is produced by GET /api/v1/all (or a frozen fixture in unit tests).
import { createHash } from 'node:crypto';
import { deepRedactSecrets } from '../memory/deepredact.js';

export type LangflowComponentDef = {
  display_name?: string;
  description?: string;
  template?: Record<string, unknown>;
  outputs?: unknown[];
  base_classes?: string[];
  [key: string]: unknown;
};

/** Nested category → componentType → definition (Langflow /api/v1/all shape). */
export type LangflowCatalogue = Record<string, Record<string, LangflowComponentDef> | unknown>;

export type ResolvedComponent = {
  category: string;
  type: string;
  def: LangflowComponentDef;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Recursive key-sorted JSON for exact, deterministic fingerprinting. */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = canonicalize(obj[key]);
  }
  return out;
}

/** Collect component type names sorted for fingerprinting. */
export function listCatalogueComponents(catalogue: unknown): Array<{ category: string; type: string }> {
  if (!isPlainObject(catalogue)) return [];
  const out: Array<{ category: string; type: string }> = [];
  for (const [category, group] of Object.entries(catalogue)) {
    if (category === 'component_display_names') continue;
    if (!isPlainObject(group)) continue;
    for (const type of Object.keys(group)) {
      const def = group[type];
      if (!isPlainObject(def)) continue;
      // Components have template and/or outputs
      if (!('template' in def) && !('outputs' in def)) continue;
      out.push({ category, type });
    }
  }
  out.sort((a, b) => `${a.category}/${a.type}`.localeCompare(`${b.category}/${b.type}`));
  return out;
}

/**
 * Deterministic catalogue fingerprint (sha256 hex).
 * Hashes full canonical, deep-redacted component definitions in sorted
 * category/type order — template/code/output leaf changes must change the digest.
 */
export function catalogueFingerprint(catalogue: unknown): string {
  const comps = listCatalogueComponents(catalogue);
  const parts: string[] = [];
  if (isPlainObject(catalogue)) {
    for (const { category, type } of comps) {
      const group = catalogue[category];
      if (!isPlainObject(group)) continue;
      const def = group[type];
      if (!isPlainObject(def)) continue;
      const redacted = deepRedactSecrets(def);
      const canonical = JSON.stringify(canonicalize(redacted));
      parts.push(`${category}\t${type}\t${canonical}`);
    }
  }
  return createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
}

/** Find a component by type name across categories (first match, sorted categories). */
export function findComponent(
  catalogue: unknown,
  componentType: string,
): ResolvedComponent | null {
  if (!isPlainObject(catalogue) || !componentType) return null;
  const categories = Object.keys(catalogue).sort();
  for (const category of categories) {
    if (category === 'component_display_names') continue;
    const group = catalogue[category];
    if (!isPlainObject(group)) continue;
    const def = group[componentType];
    if (isPlainObject(def) && ('template' in def || 'outputs' in def)) {
      return { category, type: componentType, def: def as LangflowComponentDef };
    }
  }
  return null;
}

export function deepCloneComponent(def: LangflowComponentDef): LangflowComponentDef {
  return JSON.parse(JSON.stringify(def)) as LangflowComponentDef;
}
