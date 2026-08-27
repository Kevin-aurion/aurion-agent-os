/**
 * Progressive skill disclosure helpers (L1 catalog / L2 body / L3 resources).
 *
 * L1: bounded metadata catalog → system prompt (no full contentMd).
 * L2: readSkillBody — on-demand SKILL.md under agentDir/skills/<slug>/.
 * L3: readSkillResource — on-demand files under the skill folder (path-guarded).
 *
 * Path checks are fail-closed (throw). Single-skill metadata parse is fail-safe
 * (returns deterministic safe defaults, never throws).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as YAML from 'yaml';
import { sanitizeSegment, assertInsideRoot, safeJoin } from './safepath.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface SkillMetadata {
  description: string;
  whenToUse: string;
  whenNotToUse: string;
  requiredTools: string[];
  conflictsWith: string[];
  sideEffects: string[];
  riskTier: 'low' | 'medium' | 'high';
  tokenBudget: number;
  evalSuiteId: string | null;
  version: number;
}

export interface SkillCatalogEntry {
  slug: string;
  name: string;
  metadata: SkillMetadata;
  relPath: string;
  conflicted: boolean;
}

export interface SkillLike {
  slug: string;
  name?: string;
  contentMd: string;
  assets?: unknown;
  version?: number;
}

// ── Legacy safe defaults (deterministic, fail-closed on risk) ───────────────

const TOKEN_BUDGET_DEFAULT = 2000;
const TOKEN_BUDGET_MAX = 8000;
const CATALOG_TEXT_MAX = 400;

function legacyDefaults(version: number, description = ''): SkillMetadata {
  return {
    description,
    whenToUse: '',
    whenNotToUse: '',
    requiredTools: [],
    conflictsWith: [],
    sideEffects: [],
    riskTier: 'high',
    tokenBudget: TOKEN_BUDGET_DEFAULT,
    evalSuiteId: null,
    version: version > 0 ? version : 1,
  };
}

// ── Parsing helpers (never throw) ───────────────────────────────────────────

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function parseRiskTier(v: unknown): 'low' | 'medium' | 'high' {
  if (v === 'low' || v === 'medium' || v === 'high') return v;
  return 'high';
}

function clampTokenBudget(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v <= 0) {
    return TOKEN_BUDGET_DEFAULT;
  }
  return Math.min(v, TOKEN_BUDGET_MAX);
}

function parseEvalSuiteId(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  return null;
}

function extractFrontmatter(md: string): Record<string, unknown> {
  const m = String(md ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return {};
  try {
    const parsed = YAML.parse(m[1] ?? '');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function assetsMetadata(assets: unknown): Record<string, unknown> | null {
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)) return null;
  const meta = (assets as Record<string, unknown>).metadata;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  return meta as Record<string, unknown>;
}

/**
 * Merge a partial metadata object onto defaults. Missing / invalid fields keep defaults.
 * Pure and never throws.
 */
function applyMetaOverlay(base: SkillMetadata, src: Record<string, unknown>): SkillMetadata {
  const declares =
    src.declares && typeof src.declares === 'object' && !Array.isArray(src.declares)
      ? (src.declares as Record<string, unknown>)
      : null;

  const sideEffectsRaw =
    src.sideEffects !== undefined
      ? src.sideEffects
      : src.side_effects !== undefined
        ? src.side_effects
        : declares?.side_effects;

  return {
    description: src.description !== undefined ? asString(src.description, base.description) : base.description,
    whenToUse:
      src.whenToUse !== undefined
        ? asString(src.whenToUse)
        : src.when_to_use !== undefined
          ? asString(src.when_to_use)
          : base.whenToUse,
    whenNotToUse:
      src.whenNotToUse !== undefined
        ? asString(src.whenNotToUse)
        : src.when_not_to_use !== undefined
          ? asString(src.when_not_to_use)
          : base.whenNotToUse,
    requiredTools:
      src.requiredTools !== undefined
        ? asStringArray(src.requiredTools)
        : src.required_tools !== undefined
          ? asStringArray(src.required_tools)
          : base.requiredTools,
    conflictsWith:
      src.conflictsWith !== undefined
        ? asStringArray(src.conflictsWith)
        : src.conflicts_with !== undefined
          ? asStringArray(src.conflicts_with)
          : base.conflictsWith,
    sideEffects: sideEffectsRaw !== undefined ? asStringArray(sideEffectsRaw) : base.sideEffects,
    riskTier: src.riskTier !== undefined ? parseRiskTier(src.riskTier) : base.riskTier,
    tokenBudget: src.tokenBudget !== undefined ? clampTokenBudget(src.tokenBudget) : base.tokenBudget,
    evalSuiteId: src.evalSuiteId !== undefined ? parseEvalSuiteId(src.evalSuiteId) : base.evalSuiteId,
    version: base.version,
  };
}

/**
 * Parse skill metadata. Priority: assets.metadata > YAML frontmatter > legacy defaults.
 * Never throws — single-skill failures fall back to safe defaults (fail-safe).
 */
export function parseSkillManifest(skill: {
  slug: string;
  contentMd: string;
  assets?: unknown;
  version?: number;
  name?: string;
}): SkillMetadata {
  try {
    const version = typeof skill.version === 'number' && skill.version > 0 ? skill.version : 1;
    const nameHint = typeof skill.name === 'string' ? skill.name : '';
    let meta = legacyDefaults(version, nameHint);

    const fm = extractFrontmatter(skill.contentMd ?? '');
    if (Object.keys(fm).length > 0) {
      meta = applyMetaOverlay(meta, fm);
      // Frontmatter description overrides name-hint default when present.
      if (fm.description !== undefined) {
        meta = { ...meta, description: asString(fm.description, meta.description) };
      }
    }

    const explicit = assetsMetadata(skill.assets);
    if (explicit) {
      meta = applyMetaOverlay(meta, explicit);
    }

    // version always from skill.version (not hand-editable via metadata PATCH).
    meta = { ...meta, version };
    return meta;
  } catch {
    const version = typeof skill.version === 'number' && skill.version > 0 ? skill.version : 1;
    return legacyDefaults(version, typeof skill.name === 'string' ? skill.name : '');
  }
}

// ── Path safety (fail-closed) ───────────────────────────────────────────────

/**
 * Return relative path `skills/<sanitized-slug>/SKILL.md`.
 * Throws on any malicious / invalid slug (path separators, abs, drive, pure dots).
 */
export function safeSkillRelPath(slug: string): string {
  const raw = String(slug ?? '');
  // Fail-closed: any path-like slug is rejected (separators, abs, drive, .., pure dots).
  if (
    !raw ||
    raw.includes('/') ||
    raw.includes('\\') ||
    raw.startsWith('/') ||
    raw.startsWith('\\') ||
    /^[a-zA-Z]:/.test(raw) ||
    raw.includes('..')
  ) {
    throw new Error(`invalid skill slug for path: ${raw}`);
  }
  const sanitized = sanitizeSegment(raw);
  if (!sanitized || sanitized !== raw) {
    throw new Error(`invalid skill slug for path: ${raw}`);
  }
  const rel = `skills/${sanitized}/SKILL.md`;
  if (path.isAbsolute(rel)) {
    throw new Error(`invalid skill rel path: ${rel}`);
  }
  return rel;
}

/** L2: read full SKILL.md for one skill under the materialized agent dir. */
export async function readSkillBody(agentDir: string, slug: string): Promise<string> {
  safeSkillRelPath(slug); // validate slug (throw if bad)
  const skillsRoot = path.join(agentDir, 'skills');
  const filePath = safeJoin(skillsRoot, slug, 'SKILL.md');
  return readFile(filePath, 'utf8');
}

/**
 * L3: read a resource under skills/<slug>/<relPath>.
 * Every path segment is sanitized; final path must stay inside the skill folder.
 */
export async function readSkillResource(
  agentDir: string,
  slug: string,
  relPath: string,
): Promise<Buffer> {
  safeSkillRelPath(slug);
  const raw = String(relPath ?? '');
  if (
    !raw ||
    raw.includes('\\') ||
    path.isAbsolute(raw) ||
    raw.startsWith('/') ||
    /^[a-zA-Z]:/.test(raw) ||
    raw.split('/').some((seg) => seg === '..' || seg === '.')
  ) {
    throw new Error(`unsafe skill resource path: ${raw}`);
  }
  const parts = raw.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) throw new Error(`unsafe skill resource path: ${raw}`);
  for (const p of parts) {
    const cleaned = sanitizeSegment(p);
    if (!cleaned || cleaned !== p) {
      throw new Error(`unsafe skill resource segment: ${p}`);
    }
  }
  const skillDir = safeJoin(path.join(agentDir, 'skills'), slug);
  const full = safeJoin(skillDir, ...parts);
  assertInsideRoot(skillDir, full);
  return readFile(full);
}

// ── Conflict resolution (deterministic) ─────────────────────────────────────

/**
 * Given ordered skill slugs + their conflictsWith lists, return the set of
 * slugs that lose conflict resolution (later appearance yields to earlier).
 * Deterministic: same input order → same conflicted set.
 */
export function resolveConflictedSlugs(
  entries: Array<{ slug: string; conflictsWith: string[] }>,
): Set<string> {
  const conflicted = new Set<string>();
  const kept: string[] = [];
  for (const e of entries) {
    let hitsEarlier = false;
    for (const prev of kept) {
      const prevEntry = entries.find((x) => x.slug === prev);
      const prevConflicts = prevEntry?.conflictsWith ?? [];
      if (e.conflictsWith.includes(prev) || prevConflicts.includes(e.slug)) {
        hitsEarlier = true;
        break;
      }
    }
    if (hitsEarlier) {
      conflicted.add(e.slug);
    } else {
      kept.push(e.slug);
    }
  }
  return conflicted;
}

// ── Catalog assembly ────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

/**
 * Bounded L1 catalog text for system prompt. Never includes contentMd body.
 */
export function buildSkillCatalog(
  skills: Array<{ name: string; metadata: SkillMetadata; relPath: string; conflicted?: boolean }>,
): string {
  const lines: string[] = [
    '# 技能目錄（catalog）',
    '',
    '這是你擁有的技能「目錄」——僅含 metadata 與安全相對路徑，不含完整步驟正文。',
    '需要使用某技能時，請依 relPath 讀取對應的 SKILL.md 取得完整步驟（L2 按需載入）。',
    '請勿臆造未列於目錄中的技能。',
    '',
  ];

  if (skills.length === 0) {
    lines.push('（目前沒有已確認可掛載的技能）');
    return lines.join('\n');
  }

  for (const sk of skills) {
    const m = sk.metadata;
    const conflictNote = sk.conflicted
      ? '\n- 狀態: （與其他技能衝突，未載入完整內容）'
      : '';
    const pathLine = sk.conflicted
      ? '- relPath: （衝突，不引導載入）'
      : `- relPath: ${sk.relPath}`;
    lines.push(
      [
        `## ${sk.name}`,
        `- description: ${truncate(m.description || '（無）', CATALOG_TEXT_MAX)}`,
        `- whenToUse: ${truncate(m.whenToUse || '（未指定）', CATALOG_TEXT_MAX)}`,
        `- whenNotToUse: ${truncate(m.whenNotToUse || '（未指定）', CATALOG_TEXT_MAX)}`,
        `- requiredTools: ${m.requiredTools.length ? m.requiredTools.join(', ') : '（無）'}`,
        `- sideEffects: ${m.sideEffects.length ? m.sideEffects.join(', ') : '（無）'}`,
        `- riskTier: ${m.riskTier}`,
        `- tokenBudget: ${m.tokenBudget}`,
        `- evalSuiteId: ${m.evalSuiteId ?? 'null'}`,
        `- version: ${m.version}`,
        pathLine + conflictNote,
      ].join('\n'),
    );
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/**
 * Shared catalog builder for compileManifest + GET /api/agents/:id/skills/catalog.
 * Input should already be CONFIRMED (caller filters). Malicious slugs are excluded
 * (fail-closed per skill, with console.warn). Conflicts marked deterministically.
 */
export function buildAgentSkillCatalog(skills: SkillLike[]): SkillCatalogEntry[] {
  const parsed: Array<{
    slug: string;
    name: string;
    metadata: SkillMetadata;
    relPath: string;
  }> = [];

  for (const s of skills) {
    try {
      const relPath = safeSkillRelPath(s.slug);
      const metadata = parseSkillManifest(s);
      parsed.push({
        slug: s.slug,
        name: s.name ?? s.slug,
        metadata,
        relPath,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[skillmanifest] excluding skill with unsafe slug "${s.slug}": ${msg}`);
    }
  }

  const conflicted = resolveConflictedSlugs(
    parsed.map((p) => ({ slug: p.slug, conflictsWith: p.metadata.conflictsWith })),
  );

  return parsed.map((p) => ({
    ...p,
    conflicted: conflicted.has(p.slug),
  }));
}
