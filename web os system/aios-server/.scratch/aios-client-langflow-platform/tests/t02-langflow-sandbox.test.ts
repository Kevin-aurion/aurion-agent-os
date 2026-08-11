/**
 * Ticket 02 — Isolated Langflow FDE Sandbox (Phase 2).
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t02-langflow-sandbox.test.ts
 *
 * A. Deterministic contract tests (no container required).
 * B. Live tests when Docker is available; otherwise BLOCKED (never fake-pass).
 *
 * Zero new npm deps: YAML via `docker compose … config --format json`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** web os system/ — parent of aios-server/ */
const WEB_OS_ROOT = resolve(__dirname, '../../../../');
const SANDBOX_COMPOSE = join(WEB_OS_ROOT, 'docker-compose.langflow-sandbox.yml');
const DEFAULT_COMPOSE = join(WEB_OS_ROOT, 'docker-compose.yml');

const FORBIDDEN_ENV_KEYS = new Set([
  'AIOS_JWT_SECRET',
  'AIOS_ENCRYPTION_KEY',
  'DATABASE_URL',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_CLIENT_ID',
  'MS_CLIENT_SECRET',
  'MS_CLIENT_ID',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY',
  'XAI_API_KEY',
  'GROK_API_KEY',
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_CHANNEL_SECRET',
  'LINE_WEBHOOK_SECRET',
  'REDIS_URL',
  'QDRANT_URL',
  // Production Langflow control-plane secrets must never land in sandbox compose
  'AIOS_LANGFLOW_PRODUCTION_API_KEY',
  'AIOS_LANGFLOW_PRODUCTION_SECRET_KEY',
  'AIOS_LANGFLOW_PRODUCTION_SUPERUSER_PASSWORD',
]);

/** Fixed local-only Flow API key for FDE sandbox (not production, not sk-…). */
export const SANDBOX_FLOW_API_KEY =
  'sandbox-flow-api-key-not-production-local-only-v1';

const FORBIDDEN_VOLUME_NAMES = new Set(['aios_pgdata', 'aios_redis']);

const FORBIDDEN_SOURCE_FRAGMENTS = [
  'aios-data',
  'backups',
  'aios-server',
  'aios-web',
];

const SK_RE = /sk-[A-Za-z0-9]+/;
const PG_RE = /postgresql:\/\//;
const REDIS_RE = /redis:\/\//;

let failed = 0;

function pass(label: string, detail = ''): void {
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail: string): void {
  failed += 1;
  process.exitCode = 1;
  console.log(`FAIL  ${label} — ${detail}`);
}

function check(cond: unknown, label: string, detailOnFail: string): void {
  if (cond) pass(label);
  else fail(label, detailOnFail);
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

type ComposeConfig = {
  /** Top-level compose project name (isolates scope from sibling compose files). */
  name?: string;
  services?: Record<
    string,
    {
      image?: string;
      environment?: Record<string, string> | string[] | null;
      env_file?: unknown;
      ports?: Array<{
        mode?: string;
        host_ip?: string;
        target?: number;
        published?: string | number;
        protocol?: string;
      }>;
      volumes?: Array<
        | string
        | {
            type?: string;
            source?: string;
            target?: string;
            read_only?: boolean;
          }
      >;
      healthcheck?: unknown;
    }
  >;
  volumes?: Record<string, unknown>;
};

function envAsRecord(
  env: Record<string, string> | string[] | null | undefined,
): Record<string, string> {
  if (!env) return {};
  if (Array.isArray(env)) {
    const out: Record<string, string> = {};
    for (const item of env) {
      const i = item.indexOf('=');
      if (i === -1) out[item] = '';
      else out[item.slice(0, i)] = item.slice(i + 1);
    }
    return out;
  }
  return { ...env };
}

/**
 * Pure validator: returns list of violations (empty = legal sandbox compose).
 */
export function validateSandboxCompose(configJson: unknown): string[] {
  const violations: string[] = [];
  if (!configJson || typeof configJson !== 'object') {
    return ['config is not an object'];
  }
  const cfg = configJson as ComposeConfig;
  const services = cfg.services ?? {};

  for (const [svcName, svc] of Object.entries(services)) {
    // 1. published ports must bind 127.0.0.1
    const ports = svc.ports ?? [];
    for (const p of ports) {
      if (p == null || typeof p !== 'object') {
        violations.push(`${svcName}: port entry is not an object`);
        continue;
      }
      const hostIp = p.host_ip;
      if (hostIp === undefined || hostIp === null || hostIp === '') {
        violations.push(
          `${svcName}: published port missing host_ip (must be 127.0.0.1)`,
        );
      } else if (hostIp !== '127.0.0.1') {
        violations.push(
          `${svcName}: published port host_ip is ${JSON.stringify(hostIp)} (must be 127.0.0.1)`,
        );
      }
    }

    // 2. image tag must be explicitly pinned (non-empty, not ending in :latest or /latest)
    const image = (svc.image ?? '').trim();
    if (!image) {
      violations.push(`${svcName}: image is empty`);
    } else {
      const lastSlash = image.lastIndexOf('/');
      const namePart = lastSlash >= 0 ? image.slice(lastSlash + 1) : image;
      const colon = namePart.lastIndexOf(':');
      if (colon < 0) {
        violations.push(
          `${svcName}: image ${JSON.stringify(image)} has no tag (must pin explicit version)`,
        );
      } else {
        const tag = namePart.slice(colon + 1);
        if (!tag || tag === 'latest') {
          violations.push(
            `${svcName}: image tag must be explicit pin, not latest — got ${JSON.stringify(image)}`,
          );
        }
      }
    }

    // 3. forbidden env keys + secret-like values
    if (svc.env_file != null && svc.env_file !== undefined) {
      const ef = svc.env_file;
      if (Array.isArray(ef) ? ef.length > 0 : true) {
        violations.push(`${svcName}: env_file is forbidden`);
      }
    }
    const env = envAsRecord(svc.environment);
    for (const [k, v] of Object.entries(env)) {
      if (FORBIDDEN_ENV_KEYS.has(k)) {
        violations.push(`${svcName}: forbidden env key ${k}`);
      }
      const val = String(v ?? '');
      if (SK_RE.test(val)) {
        violations.push(
          `${svcName}: env ${k} value matches sk-… pattern (credential-like)`,
        );
      }
      if (PG_RE.test(val)) {
        violations.push(
          `${svcName}: env ${k} value matches postgresql:// (production-like DB URL)`,
        );
      }
      if (REDIS_RE.test(val)) {
        violations.push(
          `${svcName}: env ${k} value matches redis://`,
        );
      }
    }

    // 3b. Ticket 23 sandbox Flow API key contract (local-only fixed placeholder)
    const apiKeySource = String(env.LANGFLOW_API_KEY_SOURCE ?? '');
    if (apiKeySource !== 'env') {
      violations.push(
        `${svcName}: LANGFLOW_API_KEY_SOURCE must be exactly "env", got ${JSON.stringify(apiKeySource)}`,
      );
    }
    const langflowApiKey = String(env.LANGFLOW_API_KEY ?? '');
    if (!langflowApiKey) {
      violations.push(
        `${svcName}: LANGFLOW_API_KEY is required (sandbox fixed placeholder)`,
      );
    } else if (/\$\{/.test(langflowApiKey)) {
      violations.push(
        `${svcName}: LANGFLOW_API_KEY must not use interpolation (\${…}); fixed sandbox placeholder only`,
      );
    } else if (langflowApiKey !== SANDBOX_FLOW_API_KEY) {
      violations.push(
        `${svcName}: LANGFLOW_API_KEY must be exactly the approved sandbox placeholder (not production/provider/other)`,
      );
    }

    // 4. forbidden mounts / volume names
    const vols = svc.volumes ?? [];
    for (const vol of vols) {
      if (typeof vol === 'string') {
        const src = vol.split(':')[0] ?? '';
        checkForbiddenSource(svcName, src, violations);
        continue;
      }
      if (vol && typeof vol === 'object') {
        const src = vol.source ?? '';
        const type = vol.type ?? (src.startsWith('/') || src.startsWith('.') ? 'bind' : 'volume');
        if (type === 'bind' || src.includes(sep) || src.startsWith('.') || src.startsWith('/')) {
          checkForbiddenSource(svcName, src, violations);
        } else if (src && FORBIDDEN_VOLUME_NAMES.has(src)) {
          violations.push(
            `${svcName}: volume name ${src} is a production volume (forbidden)`,
          );
        }
      }
    }
  }

  // top-level named volumes
  for (const volName of Object.keys(cfg.volumes ?? {})) {
    if (FORBIDDEN_VOLUME_NAMES.has(volName)) {
      violations.push(
        `top-level volume ${volName} is a production volume (forbidden)`,
      );
    }
  }

  return violations;
}

function checkForbiddenSource(
  svcName: string,
  source: string,
  violations: string[],
): void {
  if (!source) return;
  let resolved = source;
  try {
    resolved = resolve(WEB_OS_ROOT, source);
  } catch {
    resolved = source;
  }
  const lower = resolved.toLowerCase();
  const norm = resolved.split(sep).join('/');

  if (norm.endsWith('.env') || lower.includes('/.env') || source === '.env' || source.endsWith('/.env')) {
    violations.push(`${svcName}: bind mount source resolves to a .env path: ${source}`);
  }
  for (const frag of FORBIDDEN_SOURCE_FRAGMENTS) {
    // path segment match (avoid false positives like "my-aios-server-notes")
    const re = new RegExp(`(^|[/\\\\])${frag.replace(/-/g, '\\-')}([/\\\\]|$)`, 'i');
    if (re.test(resolved) || re.test(source)) {
      violations.push(
        `${svcName}: bind mount source hits forbidden path fragment ${frag}: ${source}`,
      );
    }
  }
  if (FORBIDDEN_VOLUME_NAMES.has(source)) {
    violations.push(
      `${svcName}: volume name ${source} is a production volume (forbidden)`,
    );
  }
}

function composeConfigJson(composeFile: string): ComposeConfig {
  const out = execFileSync(
    'docker',
    ['compose', '-f', composeFile, 'config', '--format', 'json'],
    { encoding: 'utf8', cwd: WEB_OS_ROOT, maxBuffer: 10 * 1024 * 1024 },
  );
  return JSON.parse(out) as ComposeConfig;
}

function composeServicesList(composeFile: string): string[] {
  const out = execFileSync(
    'docker',
    ['compose', '-f', composeFile, 'config', '--services'],
    { encoding: 'utf8', cwd: WEB_OS_ROOT },
  );
  return out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function dockerAvailable(): { ok: true } | { ok: false; reason: string } {
  try {
    execFileSync('docker', ['info'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: msg.slice(0, 200) };
  }
}

// ─── A. Deterministic contract tests ─────────────────────────────────────────

function runContractTests(): void {
  console.log('\n=== A. Deterministic contract tests ===\n');

  check(
    existsSync(SANDBOX_COMPOSE),
    'sandbox compose file exists',
    `missing ${SANDBOX_COMPOSE}`,
  );
  if (!existsSync(SANDBOX_COMPOSE)) {
    fail('cannot continue A without compose file', SANDBOX_COMPOSE);
    return;
  }

  // File-level checks
  const raw = readFileSync(SANDBOX_COMPOSE, 'utf8');
  check(!/\benv_file\b/.test(raw), 'raw compose has no env_file', 'found env_file');
  check(!raw.includes('../.env'), 'raw compose has no ../.env', 'found ../.env');
  check(
    /LANGFLOW_API_KEY_SOURCE\s*:\s*["']?env["']?/.test(raw),
    'raw YAML LANGFLOW_API_KEY_SOURCE=env',
    'missing or wrong LANGFLOW_API_KEY_SOURCE',
  );
  check(
    raw.includes(SANDBOX_FLOW_API_KEY),
    'raw YAML embeds approved sandbox Flow API key placeholder',
    'approved placeholder not found',
  );
  check(
    !/LANGFLOW_API_KEY\s*:\s*["']?\$\{/.test(raw),
    'raw YAML LANGFLOW_API_KEY is not interpolated',
    'found ${…} form (sandbox must use fixed placeholder)',
  );
  check(
    !raw.includes('AIOS_LANGFLOW_PRODUCTION_API_KEY'),
    'raw YAML has no AIOS_LANGFLOW_PRODUCTION_API_KEY',
    'production API key reference found',
  );

  let cfg: ComposeConfig;
  try {
    cfg = composeConfigJson(SANDBOX_COMPOSE);
    pass('docker compose config --format json', 'parsed OK');
  } catch (e) {
    fail(
      'docker compose config --format json',
      e instanceof Error ? e.message : String(e),
    );
    return;
  }

  // Positive: real compose must have zero violations + healthcheck
  const realViolations = validateSandboxCompose(cfg);
  check(
    realViolations.length === 0,
    'validateSandboxCompose(real) zero violations',
    realViolations.join('; ') || 'unknown',
  );

  // Project scope isolation: explicit top-level name ≠ default compose project
  check(
    cfg.name === 'aios-langflow-sandbox',
    "sandbox compose top-level name === 'aios-langflow-sandbox'",
    `got ${JSON.stringify(cfg.name)}`,
  );

  const services = cfg.services ?? {};
  const svcNames = Object.keys(services);
  check(svcNames.length >= 1, 'at least one service', `got ${svcNames.length}`);
  for (const name of svcNames) {
    const hc = services[name]?.healthcheck;
    check(
      hc != null && hc !== undefined,
      `service ${name} has healthcheck`,
      'healthcheck missing',
    );
  }

  // Negative 1a: host_ip 0.0.0.0
  {
    const bad = deepClone(cfg);
    for (const svc of Object.values(bad.services ?? {})) {
      for (const p of svc.ports ?? []) {
        if (p && typeof p === 'object') p.host_ip = '0.0.0.0';
      }
    }
    const v = validateSandboxCompose(bad);
    check(
      v.some((x) => /host_ip|0\.0\.0\.0|loopback/i.test(x)),
      'negative: host_ip 0.0.0.0 rejected',
      `violations=${JSON.stringify(v)}`,
    );
  }

  // Negative 1b: missing host_ip
  {
    const bad = deepClone(cfg);
    for (const svc of Object.values(bad.services ?? {})) {
      for (const p of svc.ports ?? []) {
        if (p && typeof p === 'object') delete p.host_ip;
      }
    }
    const v = validateSandboxCompose(bad);
    check(
      v.some((x) => /host_ip|missing/i.test(x)),
      'negative: missing host_ip rejected',
      `violations=${JSON.stringify(v)}`,
    );
  }

  // Negative 2a: OPENAI_API_KEY=sk-test123
  {
    const bad = deepClone(cfg);
    const first = Object.values(bad.services ?? {})[0];
    if (first) {
      const env = envAsRecord(first.environment);
      env.OPENAI_API_KEY = 'sk-test123';
      first.environment = env;
    }
    const v = validateSandboxCompose(bad);
    check(
      v.some((x) => /OPENAI_API_KEY|sk-/i.test(x)),
      'negative: OPENAI_API_KEY=sk-test123 rejected',
      `violations=${JSON.stringify(v)}`,
    );
  }

  // Negative 2b: DATABASE_URL=postgresql://…
  {
    const bad = deepClone(cfg);
    const first = Object.values(bad.services ?? {})[0];
    if (first) {
      const env = envAsRecord(first.environment);
      env.DATABASE_URL = 'postgresql://aios:aios@127.0.0.1:5433/aios';
      first.environment = env;
    }
    const v = validateSandboxCompose(bad);
    check(
      v.some((x) => /DATABASE_URL|postgresql/i.test(x)),
      'negative: DATABASE_URL=postgresql://… rejected',
      `violations=${JSON.stringify(v)}`,
    );
  }

  // Ticket 23: sandbox Flow API key negatives
  {
    const bad = deepClone(cfg);
    const first = Object.values(bad.services ?? {})[0];
    if (first) {
      const env = envAsRecord(first.environment);
      delete env.LANGFLOW_API_KEY;
      first.environment = env;
    }
    const v = validateSandboxCompose(bad);
    check(
      v.some((x) => /LANGFLOW_API_KEY.*required|placeholder/i.test(x)),
      'negative: missing LANGFLOW_API_KEY rejected',
      `violations=${JSON.stringify(v)}`,
    );
  }
  {
    const bad = deepClone(cfg);
    const first = Object.values(bad.services ?? {})[0];
    if (first) {
      const env = envAsRecord(first.environment);
      env.LANGFLOW_API_KEY_SOURCE = 'db';
      first.environment = env;
    }
    const v = validateSandboxCompose(bad);
    check(
      v.some((x) => /LANGFLOW_API_KEY_SOURCE/i.test(x)),
      'negative: LANGFLOW_API_KEY_SOURCE≠env rejected',
      `violations=${JSON.stringify(v)}`,
    );
  }
  {
    const bad = deepClone(cfg);
    const first = Object.values(bad.services ?? {})[0];
    if (first) {
      const env = envAsRecord(first.environment);
      env.LANGFLOW_API_KEY = 'wrong-sandbox-key';
      first.environment = env;
    }
    const v = validateSandboxCompose(bad);
    check(
      v.some((x) => /LANGFLOW_API_KEY|placeholder|approved/i.test(x)),
      'negative: wrong LANGFLOW_API_KEY value rejected',
      `violations=${JSON.stringify(v)}`,
    );
  }
  {
    const bad = deepClone(cfg);
    const first = Object.values(bad.services ?? {})[0];
    if (first) {
      const env = envAsRecord(first.environment);
      env.LANGFLOW_API_KEY = '${AIOS_LANGFLOW_PRODUCTION_API_KEY:?must-not}';
      first.environment = env;
    }
    const v = validateSandboxCompose(bad);
    check(
      v.some((x) => /interpolat|LANGFLOW_API_KEY|placeholder|approved/i.test(x)),
      'negative: interpolated LANGFLOW_API_KEY rejected',
      `violations=${JSON.stringify(v)}`,
    );
  }
  {
    const bad = deepClone(cfg);
    const first = Object.values(bad.services ?? {})[0];
    if (first) {
      const env = envAsRecord(first.environment);
      env.LANGFLOW_API_KEY = 'sk-prod-lookalike-not-allowed-zzzz';
      first.environment = env;
    }
    const v = validateSandboxCompose(bad);
    check(
      v.some((x) => /sk-|LANGFLOW_API_KEY|placeholder|credential/i.test(x)),
      'negative: sk- pattern LANGFLOW_API_KEY rejected',
      `violations=${JSON.stringify(v)}`,
    );
  }
  {
    const bad = deepClone(cfg);
    const first = Object.values(bad.services ?? {})[0];
    if (first) {
      const env = envAsRecord(first.environment);
      env.AIOS_LANGFLOW_PRODUCTION_API_KEY = 'should-not-be-here';
      first.environment = env;
    }
    const v = validateSandboxCompose(bad);
    check(
      v.some((x) => /AIOS_LANGFLOW_PRODUCTION_API_KEY|forbidden/i.test(x)),
      'negative: AIOS_LANGFLOW_PRODUCTION_API_KEY env key rejected',
      `violations=${JSON.stringify(v)}`,
    );
  }

  // Default isolation: plain docker-compose.yml must not list langflow services
  // and must use a different project name scope than the sandbox compose.
  check(existsSync(DEFAULT_COMPOSE), 'default docker-compose.yml exists', 'missing');
  if (existsSync(DEFAULT_COMPOSE)) {
    try {
      const servicesList = composeServicesList(DEFAULT_COMPOSE);
      const langflowHits = servicesList.filter((s) => /langflow/i.test(s));
      check(
        langflowHits.length === 0,
        'default compose services exclude langflow',
        `found: ${langflowHits.join(', ')}`,
      );
      pass('default compose services', servicesList.join(', '));
    } catch (e) {
      fail(
        'default compose --services',
        e instanceof Error ? e.message : String(e),
      );
    }
    try {
      const defaultCfg = composeConfigJson(DEFAULT_COMPOSE);
      const defaultName = defaultCfg.name ?? '';
      check(
        defaultName !== 'aios-langflow-sandbox' &&
          defaultName !== (cfg.name ?? ''),
        'sandbox project name ≠ default compose project scope',
        `sandbox=${JSON.stringify(cfg.name)} default=${JSON.stringify(defaultName)}`,
      );
      pass('default compose project name', defaultName || '(empty)');
    } catch (e) {
      fail(
        'default compose project name',
        e instanceof Error ? e.message : String(e),
      );
    }
  }
}

// ─── B. Live tests ───────────────────────────────────────────────────────────

async function runLiveTestsAsync(): Promise<void> {
  console.log('\n=== B. Live tests ===\n');

  const avail = dockerAvailable();
  if (!avail.ok) {
    console.log(`BLOCKED live: docker unavailable — ${avail.reason}`);
    return;
  }

  if (!existsSync(SANDBOX_COMPOSE)) {
    console.log('BLOCKED live: sandbox compose file missing');
    return;
  }

  const composeArgs = ['compose', '-f', SANDBOX_COMPOSE];
  let started = false;

  try {
    console.log('… docker compose up -d --wait (timeout up to 10 min for first pull)');
    execFileSync('docker', [...composeArgs, 'up', '-d', '--wait'], {
      encoding: 'utf8',
      cwd: WEB_OS_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    started = true;
    pass('docker compose up -d --wait');
  } catch (e) {
    const err = e as { stderr?: string; message?: string; stdout?: string };
    const detail = [err.stderr, err.stdout, err.message]
      .filter(Boolean)
      .join('\n')
      .slice(0, 800);
    console.log(`BLOCKED live: compose up / pull failed — ${detail}`);
    try {
      execFileSync('docker', [...composeArgs, 'down'], {
        encoding: 'utf8',
        cwd: WEB_OS_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      });
    } catch {
      /* ignore */
    }
    return;
  }

  try {
    // Health probe
    try {
      const res = await fetch('http://127.0.0.1:7860/health');
      check(res.status === 200, 'GET /health → 200', `HTTP ${res.status}`);
    } catch (e) {
      fail(
        'GET /health → 200',
        e instanceof Error ? e.message : String(e),
      );
    }

    // Binding verification
    try {
      const portOut = execFileSync(
        'docker',
        ['port', 'aios-langflow-sandbox'],
        { encoding: 'utf8' },
      ).trim();
      const lines = portOut.split(/\r?\n/).filter(Boolean);
      const allLoopback =
        lines.length > 0 && lines.every((l) => /127\.0\.0\.1/.test(l));
      check(
        allLoopback,
        'docker port binds 127.0.0.1',
        `output: ${portOut}`,
      );
      if (allLoopback) pass('docker port output', portOut.replace(/\n/g, ' | '));
    } catch (e) {
      fail(
        'docker port aios-langflow-sandbox',
        e instanceof Error ? e.message : String(e),
      );
    }
  } finally {
    if (started) {
      try {
        execFileSync('docker', [...composeArgs, 'down'], {
          encoding: 'utf8',
          cwd: WEB_OS_ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 120_000,
        });
        pass('docker compose down (volume retained)');
      } catch (e) {
        fail(
          'docker compose down',
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  }
}

async function main(): Promise<void> {
  console.log('Ticket 02 — Langflow FDE Sandbox isolation tests');
  console.log(`WEB_OS_ROOT=${WEB_OS_ROOT}`);
  console.log(`SANDBOX_COMPOSE=${SANDBOX_COMPOSE}`);

  runContractTests();
  await runLiveTestsAsync();

  console.log(
    `\n=== done: ${failed === 0 ? 'ALL PASS (or live BLOCKED without A failures)' : `${failed} FAIL(s)`} ===`,
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
