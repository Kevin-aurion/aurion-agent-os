/**
 * Ticket 17 — Langflow Production Runtime isolation (Phase 1: RED tests).
 * Run: npx tsx .scratch/aios-client-langflow-platform/tests/t17-production-isolation.test.ts
 *
 * A. Deterministic contract tests (no container required) via
 *    `docker compose -f … config --format json` + pure validateProductionCompose.
 * B. Live isolation when Docker is available; otherwise BLOCKED (never fake-pass).
 *
 * Target (Phase 2): docker-compose.langflow-production.yml at web os system/ root.
 * Zero new npm deps. No git. Does not modify sandbox compose or default compose.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { prisma } from '../../../src/lib/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** web os system/ — parent of aios-server/ */
const WEB_OS_ROOT = resolve(__dirname, '../../../../');
const PRODUCTION_COMPOSE = join(WEB_OS_ROOT, 'docker-compose.langflow-production.yml');
const SANDBOX_COMPOSE = join(WEB_OS_ROOT, 'docker-compose.langflow-sandbox.yml');
const DEFAULT_COMPOSE = join(WEB_OS_ROOT, 'docker-compose.yml');

const EXPECTED_IMAGE = 'langflowai/langflow:1.11.2';
const EXPECTED_PROJECT = 'aios-langflow-production';
const SANDBOX_PROJECT = 'aios-langflow-sandbox';
const EXPECTED_NET = 'aios_langflow_production_net';
const SANDBOX_NET = 'aios_langflow_sandbox_net';
const PRODUCTION_PORT = 7861;
const SANDBOX_PORT = 7860;
const CONTAINER_NAME = 'aios-langflow-production';
const SANDBOX_CONTAINER = 'aios-langflow-sandbox';

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
]);

const LINE_KEY_PREFIX = 'LINE_';

const FORBIDDEN_VOLUME_NAMES = new Set([
  'aios_langflow_sandbox',
  'aios_pgdata',
  'aios_redis',
]);

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
let passed = 0;

function pass(label: string, detail = ''): void {
  passed += 1;
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

function blocked(label: string, detail: string): void {
  console.log(`BLOCKED  ${label} — ${detail}`);
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

type PortEntry = {
  mode?: string;
  host_ip?: string;
  target?: number;
  published?: string | number;
  protocol?: string;
};

type VolumeEntry =
  | string
  | {
      type?: string;
      source?: string;
      target?: string;
      read_only?: boolean;
    };

type ServiceConfig = {
  image?: string;
  container_name?: string;
  environment?: Record<string, string> | string[] | null;
  env_file?: unknown;
  ports?: PortEntry[];
  volumes?: VolumeEntry[] | null;
  healthcheck?: unknown;
  read_only?: boolean;
  cap_drop?: string[] | null;
  security_opt?: string[] | null;
  tmpfs?: unknown;
  deploy?: {
    resources?: {
      limits?: {
        cpus?: string | number;
        memory?: string | number;
      };
    };
  };
  mem_limit?: string | number | null;
  cpus?: string | number | null;
  networks?: Record<string, unknown> | string[] | null;
};

type ComposeConfig = {
  name?: string;
  services?: Record<string, ServiceConfig>;
  volumes?: Record<string, unknown> | null;
  networks?: Record<string, { name?: string } | null> | null;
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

function publishedPorts(svc: ServiceConfig): number[] {
  const out: number[] = [];
  for (const p of svc.ports ?? []) {
    if (p == null || typeof p !== 'object') continue;
    if (p.published === undefined || p.published === null || p.published === '') continue;
    const n = typeof p.published === 'number' ? p.published : Number(p.published);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function collectPublishedPorts(cfg: ComposeConfig): Set<number> {
  const set = new Set<number>();
  for (const svc of Object.values(cfg.services ?? {})) {
    for (const n of publishedPorts(svc)) set.add(n);
  }
  return set;
}

function serviceNetworks(svc: ServiceConfig): string[] {
  const n = svc.networks;
  if (!n) return [];
  if (Array.isArray(n)) return n.map(String);
  return Object.keys(n);
}

function topLevelNetworkNames(cfg: ComposeConfig): string[] {
  const nets = cfg.networks ?? {};
  const names: string[] = [];
  for (const [key, val] of Object.entries(nets)) {
    if (val && typeof val === 'object' && typeof val.name === 'string' && val.name) {
      names.push(val.name);
    } else {
      names.push(key);
    }
  }
  return names;
}

function hasResourceLimits(svc: ServiceConfig): boolean {
  const limits = svc.deploy?.resources?.limits;
  const hasDeploy =
    limits != null &&
    limits.cpus !== undefined &&
    limits.cpus !== null &&
    limits.cpus !== '' &&
    limits.memory !== undefined &&
    limits.memory !== null &&
    limits.memory !== '';
  const hasLegacy =
    svc.mem_limit != null &&
    svc.mem_limit !== '' &&
    svc.cpus != null &&
    svc.cpus !== '';
  return Boolean(hasDeploy || hasLegacy);
}

function hasTmpfs(svc: ServiceConfig): boolean {
  const t = svc.tmpfs;
  if (t == null) return false;
  if (Array.isArray(t)) return t.length > 0;
  if (typeof t === 'object') return Object.keys(t as object).length > 0;
  if (typeof t === 'string') return t.length > 0;
  return false;
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

  if (
    norm.endsWith('.env') ||
    lower.includes('/.env') ||
    source === '.env' ||
    source.endsWith('/.env')
  ) {
    violations.push(`${svcName}: bind mount source resolves to a .env path: ${source}`);
  }
  for (const frag of FORBIDDEN_SOURCE_FRAGMENTS) {
    const re = new RegExp(`(^|[/\\\\])${frag.replace(/-/g, '\\-')}([/\\\\]|$)`, 'i');
    if (re.test(resolved) || re.test(source)) {
      violations.push(
        `${svcName}: bind mount source hits forbidden path fragment ${frag}: ${source}`,
      );
    }
  }
  if (FORBIDDEN_VOLUME_NAMES.has(source)) {
    violations.push(
      `${svcName}: volume name ${source} is forbidden (sandbox/prod data volume)`,
    );
  }
}

/**
 * Pure validator: returns list of violations (empty = legal production compose).
 * Compares against sandboxConfigJson for port/network/project isolation.
 */
export function validateProductionCompose(
  configJson: unknown,
  sandboxConfigJson: unknown,
): string[] {
  const violations: string[] = [];
  if (!configJson || typeof configJson !== 'object') {
    return ['config is not an object'];
  }
  const cfg = configJson as ComposeConfig;
  const sandbox =
    sandboxConfigJson && typeof sandboxConfigJson === 'object'
      ? (sandboxConfigJson as ComposeConfig)
      : ({} as ComposeConfig);

  // 1. top-level project name isolation
  if (cfg.name !== EXPECTED_PROJECT) {
    violations.push(
      `top-level name must be ${JSON.stringify(EXPECTED_PROJECT)}, got ${JSON.stringify(cfg.name)}`,
    );
  }
  if (cfg.name === SANDBOX_PROJECT) {
    violations.push(`top-level name must not equal sandbox project ${SANDBOX_PROJECT}`);
  }
  if (sandbox.name && cfg.name && cfg.name === sandbox.name) {
    violations.push(`production name collides with sandbox name ${sandbox.name}`);
  }

  const sandboxPorts = collectPublishedPorts(sandbox);
  const productionPorts = collectPublishedPorts(cfg);

  // 7. network isolation (top-level)
  const prodNets = topLevelNetworkNames(cfg);
  const sandboxNets = topLevelNetworkNames(sandbox);
  if (!prodNets.includes(EXPECTED_NET) && !prodNets.some((n) => n === EXPECTED_NET)) {
    // allow key or resolved name equal to EXPECTED_NET
    const hasExpected = prodNets.some((n) => n === EXPECTED_NET);
    if (!hasExpected) {
      violations.push(
        `network must include ${EXPECTED_NET}, got ${JSON.stringify(prodNets)}`,
      );
    }
  }
  for (const n of prodNets) {
    if (n === SANDBOX_NET || sandboxNets.includes(n)) {
      violations.push(`network ${n} collides with sandbox network`);
    }
  }

  // 6. top-level volumes must not be declared
  const topVols = cfg.volumes;
  if (topVols && typeof topVols === 'object' && Object.keys(topVols).length > 0) {
    violations.push(
      `top-level volumes must not be declared (got ${Object.keys(topVols).join(', ')})`,
    );
  }
  for (const volName of Object.keys(topVols ?? {})) {
    if (FORBIDDEN_VOLUME_NAMES.has(volName)) {
      violations.push(`top-level volume ${volName} is forbidden`);
    }
  }

  const services = cfg.services ?? {};
  if (Object.keys(services).length === 0) {
    violations.push('no services defined');
  }

  for (const [svcName, svc] of Object.entries(services)) {
    // 2. ports: loopback + disjoint from sandbox
    const ports = svc.ports ?? [];
    if (ports.length === 0) {
      violations.push(`${svcName}: must publish a loopback port (expected ${PRODUCTION_PORT})`);
    }
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
      const pub =
        p.published === undefined || p.published === null || p.published === ''
          ? NaN
          : typeof p.published === 'number'
            ? p.published
            : Number(p.published);
      if (Number.isFinite(pub) && sandboxPorts.has(pub)) {
        violations.push(
          `${svcName}: published port ${pub} collides with sandbox published ports`,
        );
      }
      if (Number.isFinite(pub) && pub === SANDBOX_PORT) {
        violations.push(
          `${svcName}: published port ${pub} must not equal sandbox port ${SANDBOX_PORT}`,
        );
      }
    }
    // Prefer production on 7861 when ports present
    const pubs = publishedPorts(svc);
    if (pubs.length > 0 && !pubs.includes(PRODUCTION_PORT)) {
      violations.push(
        `${svcName}: expected published port ${PRODUCTION_PORT}, got ${JSON.stringify(pubs)}`,
      );
    }

    // 3. image pin
    const image = (svc.image ?? '').trim();
    if (!image) {
      violations.push(`${svcName}: image is empty`);
    } else {
      if (image !== EXPECTED_IMAGE) {
        // still allow any explicit pin that is not latest — but ticket pins 1.11.2
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
          } else if (image !== EXPECTED_IMAGE) {
            violations.push(
              `${svcName}: image must be ${EXPECTED_IMAGE}, got ${JSON.stringify(image)}`,
            );
          }
        }
      }
    }

    // 4. hardening: read_only, cap_drop ALL, security_opt, tmpfs, resource limits
    if (svc.read_only !== true) {
      violations.push(`${svcName}: read_only must be true (writable rootfs forbidden)`);
    }
    const capDrop = (svc.cap_drop ?? []).map((c) => String(c).toUpperCase());
    if (!capDrop.includes('ALL')) {
      violations.push(`${svcName}: cap_drop must include ALL`);
    }
    const secOpt = (svc.security_opt ?? []).map(String);
    const hasNoNewPriv = secOpt.some(
      (s) =>
        s === 'no-new-privileges:true' ||
        s === 'no-new-privileges' ||
        s.includes('no-new-privileges'),
    );
    if (!hasNoNewPriv) {
      violations.push(`${svcName}: security_opt must include no-new-privileges:true`);
    }
    if (!hasTmpfs(svc)) {
      violations.push(`${svcName}: tmpfs must be present (writable dirs only via tmpfs)`);
    }
    if (!hasResourceLimits(svc)) {
      violations.push(
        `${svcName}: resource limits required (deploy.resources.limits cpus+memory or mem_limit+cpus)`,
      );
    }

    // 5. env_file forbidden + forbidden keys/values
    if (svc.env_file != null && svc.env_file !== undefined) {
      const ef = svc.env_file;
      if (Array.isArray(ef) ? ef.length > 0 : true) {
        violations.push(`${svcName}: env_file is forbidden`);
      }
    }
    const env = envAsRecord(svc.environment);
    for (const [k, v] of Object.entries(env)) {
      if (FORBIDDEN_ENV_KEYS.has(k) || k.startsWith(LINE_KEY_PREFIX)) {
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
          `${svcName}: env ${k} value matches postgresql:// (must not point at AIOS Postgres)`,
        );
      }
      if (REDIS_RE.test(val)) {
        violations.push(`${svcName}: env ${k} value matches redis://`);
      }
    }

    // 8. LANGFLOW_BACKEND_ONLY / AUTO_LOGIN / sqlite
    const backendOnly = String(env.LANGFLOW_BACKEND_ONLY ?? '');
    if (backendOnly !== 'true') {
      violations.push(
        `${svcName}: LANGFLOW_BACKEND_ONLY must be "true" (no End-User UI), got ${JSON.stringify(backendOnly)}`,
      );
    }
    const autoLogin = String(env.LANGFLOW_AUTO_LOGIN ?? '');
    if (autoLogin !== 'false') {
      violations.push(
        `${svcName}: LANGFLOW_AUTO_LOGIN must be "false", got ${JSON.stringify(autoLogin)}`,
      );
    }
    // Ticket 23: control-plane API key (x-api-key) — allowlisted, required; not a provider key.
    // LANGFLOW_API_KEY / LANGFLOW_API_KEY_SOURCE are intentionally NOT in FORBIDDEN_ENV_KEYS.
    const apiKeySource = String(env.LANGFLOW_API_KEY_SOURCE ?? '');
    if (apiKeySource !== 'env') {
      violations.push(
        `${svcName}: LANGFLOW_API_KEY_SOURCE must be "env" (control-plane API key), got ${JSON.stringify(apiKeySource)}`,
      );
    }
    const langflowApiKey = String(env.LANGFLOW_API_KEY ?? '');
    if (!langflowApiKey || langflowApiKey.trim() === '') {
      violations.push(
        `${svcName}: LANGFLOW_API_KEY must be non-empty (control-plane API key from AIOS_LANGFLOW_PRODUCTION_API_KEY)`,
      );
    }
    // Local runtime bootstrap password (not a provider key); required and distinct from SECRET_KEY host var.
    const superuserPassword = String(env.LANGFLOW_SUPERUSER_PASSWORD ?? '');
    if (!superuserPassword || superuserPassword.trim() === '') {
      violations.push(
        `${svcName}: LANGFLOW_SUPERUSER_PASSWORD must be non-empty (from AIOS_LANGFLOW_PRODUCTION_SUPERUSER_PASSWORD)`,
      );
    }
    const dbUrl = String(
      env.LANGFLOW_DATABASE_URL ?? env.DATABASE_URL ?? '',
    );
    if (!dbUrl.startsWith('sqlite://')) {
      violations.push(
        `${svcName}: DB must be sqlite on tmpfs (value starts with sqlite://), got ${JSON.stringify(dbUrl)}`,
      );
    }
    if (PG_RE.test(dbUrl)) {
      violations.push(`${svcName}: DB must not point at Postgres`);
    }

    // 6. service volumes must be empty / absent (durable state in AIOS Postgres)
    const vols = svc.volumes;
    if (vols != null && Array.isArray(vols) && vols.length > 0) {
      violations.push(
        `${svcName}: service volumes must be empty (got ${vols.length} mount(s); use tmpfs only)`,
      );
      for (const vol of vols) {
        if (typeof vol === 'string') {
          const src = vol.split(':')[0] ?? '';
          checkForbiddenSource(svcName, src, violations);
          continue;
        }
        if (vol && typeof vol === 'object') {
          const src = vol.source ?? '';
          const type =
            vol.type ??
            (src.startsWith('/') || src.startsWith('.') ? 'bind' : 'volume');
          if (
            type === 'bind' ||
            src.includes(sep) ||
            src.startsWith('.') ||
            src.startsWith('/')
          ) {
            checkForbiddenSource(svcName, src, violations);
          } else if (src && FORBIDDEN_VOLUME_NAMES.has(src)) {
            violations.push(
              `${svcName}: volume name ${src} is forbidden (sandbox/prod data volume)`,
            );
          }
          if (src === 'aios_langflow_sandbox' || src.includes('aios_langflow_sandbox')) {
            violations.push(`${svcName}: must not share aios_langflow_sandbox volume`);
          }
        }
      }
    }

    // service network attachment
    const svcNets = serviceNetworks(svc);
    if (svcNets.length > 0) {
      if (!svcNets.includes(EXPECTED_NET)) {
        violations.push(
          `${svcName}: must attach to ${EXPECTED_NET}, got ${JSON.stringify(svcNets)}`,
        );
      }
      for (const n of svcNets) {
        if (n === SANDBOX_NET) {
          violations.push(`${svcName}: must not join sandbox network ${SANDBOX_NET}`);
        }
      }
    }

    // 9. healthcheck
    if (svc.healthcheck == null || svc.healthcheck === undefined) {
      violations.push(`${svcName}: healthcheck must exist`);
    }
  }

  // port set intersection with sandbox
  for (const p of productionPorts) {
    if (sandboxPorts.has(p)) {
      violations.push(
        `published port set intersects sandbox: production has ${p} also in sandbox`,
      );
    }
  }

  return violations;
}

function composeConfigJson(
  composeFile: string,
  env: NodeJS.ProcessEnv = process.env,
): ComposeConfig {
  const out = execFileSync(
    'docker',
    ['compose', '-f', composeFile, 'config', '--format', 'json'],
    {
      encoding: 'utf8',
      cwd: WEB_OS_ROOT,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, ...env },
    },
  );
  return JSON.parse(out) as ComposeConfig;
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

function containerRunning(name: string): boolean {
  try {
    const out = execFileSync(
      'docker',
      ['inspect', '-f', '{{.State.Running}}', name],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 },
    ).trim();
    return out === 'true';
  } catch {
    return false;
  }
}

function dummySecret(): string {
  return `test-only-t17-${randomBytes(16).toString('hex')}`;
}

/** Synthetic legal production config for mutation tests when real compose is absent. */
function syntheticLegalProductionConfig(): ComposeConfig {
  return {
    name: EXPECTED_PROJECT,
    networks: {
      [EXPECTED_NET]: { name: EXPECTED_NET },
    },
    services: {
      'langflow-production': {
        image: EXPECTED_IMAGE,
        container_name: CONTAINER_NAME,
        read_only: true,
        cap_drop: ['ALL'],
        security_opt: ['no-new-privileges:true'],
        tmpfs: ['/tmp', '/app/langflow'],
        deploy: {
          resources: {
            limits: { cpus: 1, memory: '1073741824' },
          },
        },
        mem_limit: '1073741824',
        cpus: 1,
        ports: [
          {
            mode: 'ingress',
            host_ip: '127.0.0.1',
            target: 7860,
            published: String(PRODUCTION_PORT),
            protocol: 'tcp',
          },
        ],
        environment: {
          LANGFLOW_AUTO_LOGIN: 'false',
          LANGFLOW_BACKEND_ONLY: 'true',
          LANGFLOW_CONFIG_DIR: '/tmp/langflow',
          LANGFLOW_DATABASE_URL: 'sqlite:////tmp/langflow/prod.db',
          LANGFLOW_SECRET_KEY: 'resolved-from-env-placeholder-value',
          // Ticket 23: control-plane API key allowlist (not a provider credential)
          LANGFLOW_API_KEY_SOURCE: 'env',
          LANGFLOW_API_KEY: 'resolved-control-plane-api-key-placeholder',
          // Local runtime bootstrap password (split from SECRET_KEY)
          LANGFLOW_SUPERUSER: 'aios-production',
          LANGFLOW_SUPERUSER_PASSWORD: 'resolved-superuser-password-placeholder',
        },
        networks: { [EXPECTED_NET]: null },
        healthcheck: {
          test: [
            'CMD-SHELL',
            "python -c \"import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:7860/health').status==200 else 1)\"",
          ],
          timeout: '10s',
          interval: '15s',
          retries: 20,
          start_period: '1m0s',
        },
        volumes: null,
      },
    },
    volumes: null,
  };
}

function loadSandboxConfig(): ComposeConfig | null {
  if (!existsSync(SANDBOX_COMPOSE)) return null;
  try {
    return composeConfigJson(SANDBOX_COMPOSE);
  } catch {
    return null;
  }
}

// ─── A. Deterministic contract tests ─────────────────────────────────────────

function runContractTests(): void {
  console.log('\n=== A. Deterministic contract tests ===\n');

  check(
    existsSync(PRODUCTION_COMPOSE),
    'production compose file exists',
    `missing ${PRODUCTION_COMPOSE}`,
  );

  const sandboxCfg = loadSandboxConfig();
  if (sandboxCfg) {
    pass('sandbox compose config loaded (for isolation compare)');
  } else {
    // still allow mutations vs empty sandbox ports when sandbox missing
    fail(
      'sandbox compose config loaded (for isolation compare)',
      `cannot load ${SANDBOX_COMPOSE}`,
    );
  }
  const sandboxForValidate: ComposeConfig = sandboxCfg ?? {
    name: SANDBOX_PROJECT,
    services: {
      'langflow-sandbox': {
        ports: [
          {
            host_ip: '127.0.0.1',
            published: String(SANDBOX_PORT),
            target: 7860,
          },
        ],
      },
    },
    networks: { [SANDBOX_NET]: { name: SANDBOX_NET } },
  };

  // Synthetic legal baseline must pass validator (guards the pure function itself)
  {
    const legal = syntheticLegalProductionConfig();
    const v = validateProductionCompose(legal, sandboxForValidate);
    check(
      v.length === 0,
      'validateProductionCompose(synthetic legal) zero violations',
      v.join('; ') || 'unknown',
    );
  }

  let cfg: ComposeConfig | null = null;
  let raw = '';

  if (!existsSync(PRODUCTION_COMPOSE)) {
    fail(
      'cannot run live compose-config contract without production compose file',
      PRODUCTION_COMPOSE,
    );
  } else {
    raw = readFileSync(PRODUCTION_COMPOSE, 'utf8');
    check(!/\benv_file\b/.test(raw), 'raw compose has no env_file', 'found env_file');
    check(!raw.includes('../.env'), 'raw compose has no ../.env', 'found ../.env');
    check(
      !raw.includes('AIOS_JWT_SECRET') && !raw.includes('OPENAI_API_KEY'),
      'raw compose has no AIOS/provider secret key names as literals to inject',
      'found forbidden key name',
    );

    // LANGFLOW_SECRET_KEY must be secrets reference form, not literal
    const secretRefRe =
      /LANGFLOW_SECRET_KEY\s*:\s*["']?\$\{AIOS_LANGFLOW_PRODUCTION_SECRET_KEY:\?[^}]*\}["']?/;
    check(
      secretRefRe.test(raw),
      'raw YAML LANGFLOW_SECRET_KEY uses ${AIOS_LANGFLOW_PRODUCTION_SECRET_KEY:?…} form',
      'missing or wrong secrets reference form',
    );
    // No obvious hardcoded long secret literal next to LANGFLOW_SECRET_KEY
    const hardcodedSecret = /LANGFLOW_SECRET_KEY\s*:\s*["'](?!\$\{)[^"']{16,}["']/;
    check(
      !hardcodedSecret.test(raw),
      'raw YAML has no hardcoded LANGFLOW_SECRET_KEY literal value',
      'found hardcoded secret value',
    );

    // Ticket 23: control-plane API key source + secrets reference (not provider key)
    check(
      /LANGFLOW_API_KEY_SOURCE\s*:\s*["']?env["']?/.test(raw),
      'raw YAML LANGFLOW_API_KEY_SOURCE=env',
      'missing or wrong LANGFLOW_API_KEY_SOURCE',
    );
    const apiKeyRefRe =
      /LANGFLOW_API_KEY\s*:\s*["']?\$\{AIOS_LANGFLOW_PRODUCTION_API_KEY:\?[^}]*\}["']?/;
    check(
      apiKeyRefRe.test(raw),
      'raw YAML LANGFLOW_API_KEY uses ${AIOS_LANGFLOW_PRODUCTION_API_KEY:?…} form',
      'missing or wrong API key secrets reference form',
    );
    // Reject ANY non-${...} literal (including short values like "x" or unquoted abcd).
    // Does not match LANGFLOW_API_KEY_SOURCE (requires KEY then optional space then ':').
    const hardcodedApiKey =
      /LANGFLOW_API_KEY\s*:\s*["']?(?!\$\{)[^\s"'#]+/;
    check(
      !hardcodedApiKey.test(raw),
      'raw YAML has no hardcoded LANGFLOW_API_KEY literal value',
      'found hardcoded API key value',
    );
    // Negative proof: short literal must be detected
    {
      const shortLiteralYaml = 'LANGFLOW_API_KEY: "x"\n';
      check(
        hardcodedApiKey.test(shortLiteralYaml),
        'negative: short hardcoded LANGFLOW_API_KEY literal "x" is detected',
        'detector missed short literal',
      );
      const unquotedShort = 'LANGFLOW_API_KEY: ab\n';
      check(
        hardcodedApiKey.test(unquotedShort),
        'negative: short unquoted LANGFLOW_API_KEY literal is detected',
        'detector missed unquoted short literal',
      );
      const refOk = 'LANGFLOW_API_KEY: "${AIOS_LANGFLOW_PRODUCTION_API_KEY:?must be set}"\n';
      check(
        !hardcodedApiKey.test(refOk),
        'secrets-reference LANGFLOW_API_KEY is not flagged as hardcoded',
        'false positive on ${…} form',
      );
    }

    // SUPERUSER_PASSWORD must be a separate fail-closed secrets reference (not SECRET_KEY)
    const superuserPwRefRe =
      /LANGFLOW_SUPERUSER_PASSWORD\s*:\s*["']?\$\{AIOS_LANGFLOW_PRODUCTION_SUPERUSER_PASSWORD:\?[^}]*\}["']?/;
    check(
      superuserPwRefRe.test(raw),
      'raw YAML LANGFLOW_SUPERUSER_PASSWORD uses ${AIOS_LANGFLOW_PRODUCTION_SUPERUSER_PASSWORD:?…} form',
      'missing or wrong superuser password secrets reference form',
    );
    check(
      !/LANGFLOW_SUPERUSER_PASSWORD\s*:\s*["']?\$\{AIOS_LANGFLOW_PRODUCTION_SECRET_KEY/.test(
        raw,
      ),
      'raw YAML SUPERUSER_PASSWORD is not aliased to SECRET_KEY',
      'SUPERUSER_PASSWORD still references SECRET_KEY',
    );

    // Missing-variable negatives only: Compose auto-loads project `.env` from cwd and
    // would re-inject the deleted key. Disable that with `--env-file /dev/null` while
    // supplying the other required vars via `env`. Normal config/live paths stay unchanged
    // (they intentionally may use project `.env` + explicit env overrides).
    const composeConfigNoDotenvArgs = [
      'compose',
      '-f',
      PRODUCTION_COMPOSE,
      '--env-file',
      '/dev/null',
      'config',
      '--format',
      'json',
    ];

    // Fail-closed: without SECRET_KEY env var, docker compose config must fail
    {
      const envWithout = { ...process.env };
      delete envWithout.AIOS_LANGFLOW_PRODUCTION_SECRET_KEY;
      // Keep other required secrets so only SECRET_KEY absence is tested
      envWithout.AIOS_LANGFLOW_PRODUCTION_API_KEY = dummySecret();
      envWithout.AIOS_LANGFLOW_PRODUCTION_SUPERUSER_PASSWORD = dummySecret();
      try {
        execFileSync('docker', composeConfigNoDotenvArgs, {
          encoding: 'utf8',
          cwd: WEB_OS_ROOT,
          env: envWithout,
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 10 * 1024 * 1024,
        });
        fail(
          'compose config without AIOS_LANGFLOW_PRODUCTION_SECRET_KEY fails (fail-closed)',
          'config succeeded unexpectedly',
        );
      } catch {
        pass(
          'compose config without AIOS_LANGFLOW_PRODUCTION_SECRET_KEY fails (fail-closed)',
        );
      }
    }

    // Ticket 23: Fail-closed without control-plane API key
    {
      const envWithout = { ...process.env };
      envWithout.AIOS_LANGFLOW_PRODUCTION_SECRET_KEY = dummySecret();
      envWithout.AIOS_LANGFLOW_PRODUCTION_SUPERUSER_PASSWORD = dummySecret();
      delete envWithout.AIOS_LANGFLOW_PRODUCTION_API_KEY;
      try {
        execFileSync('docker', composeConfigNoDotenvArgs, {
          encoding: 'utf8',
          cwd: WEB_OS_ROOT,
          env: envWithout,
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 10 * 1024 * 1024,
        });
        fail(
          'compose config without AIOS_LANGFLOW_PRODUCTION_API_KEY fails (fail-closed)',
          'config succeeded unexpectedly',
        );
      } catch {
        pass(
          'compose config without AIOS_LANGFLOW_PRODUCTION_API_KEY fails (fail-closed)',
        );
      }
    }

    // Ticket 23 review: Fail-closed without SUPERUSER_PASSWORD (split from SECRET_KEY)
    {
      const envWithout = { ...process.env };
      envWithout.AIOS_LANGFLOW_PRODUCTION_SECRET_KEY = dummySecret();
      envWithout.AIOS_LANGFLOW_PRODUCTION_API_KEY = dummySecret();
      delete envWithout.AIOS_LANGFLOW_PRODUCTION_SUPERUSER_PASSWORD;
      try {
        execFileSync('docker', composeConfigNoDotenvArgs, {
          encoding: 'utf8',
          cwd: WEB_OS_ROOT,
          env: envWithout,
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 10 * 1024 * 1024,
        });
        fail(
          'compose config without AIOS_LANGFLOW_PRODUCTION_SUPERUSER_PASSWORD fails (fail-closed)',
          'config succeeded unexpectedly',
        );
      } catch {
        pass(
          'compose config without AIOS_LANGFLOW_PRODUCTION_SUPERUSER_PASSWORD fails (fail-closed)',
        );
      }
    }

    const secret = dummySecret();
    const apiKey = dummySecret();
    const superuserPassword = dummySecret();
    try {
      cfg = composeConfigJson(PRODUCTION_COMPOSE, {
        ...process.env,
        AIOS_LANGFLOW_PRODUCTION_SECRET_KEY: secret,
        AIOS_LANGFLOW_PRODUCTION_API_KEY: apiKey,
        AIOS_LANGFLOW_PRODUCTION_SUPERUSER_PASSWORD: superuserPassword,
      });
      pass('docker compose config --format json (with dummy secret)', 'parsed OK');
    } catch (e) {
      fail(
        'docker compose config --format json (with dummy secret)',
        e instanceof Error ? e.message : String(e),
      );
    }

    if (cfg) {
      const realViolations = validateProductionCompose(cfg, sandboxForValidate);
      check(
        realViolations.length === 0,
        'validateProductionCompose(real) zero violations',
        realViolations.join('; ') || 'unknown',
      );
      check(
        cfg.name === EXPECTED_PROJECT,
        `production compose top-level name === '${EXPECTED_PROJECT}'`,
        `got ${JSON.stringify(cfg.name)}`,
      );
      const services = cfg.services ?? {};
      for (const name of Object.keys(services)) {
        check(
          services[name]?.healthcheck != null,
          `service ${name} has healthcheck`,
          'healthcheck missing',
        );
      }
    }
  }

  // Use real cfg if available, else synthetic for mutation matrix
  const base = cfg ?? syntheticLegalProductionConfig();

  // ── Negative mutation matrix ──────────────────────────────────────────
  console.log('\n── negative mutations (validateProductionCompose) ──');

  // writable root
  {
    const bad = deepClone(base);
    for (const svc of Object.values(bad.services ?? {})) {
      delete (svc as { read_only?: boolean }).read_only;
    }
    const v = validateProductionCompose(bad, sandboxForValidate);
    check(
      v.some((x) => /read_only|writable/i.test(x)),
      'negative: writable root (read_only removed) rejected',
      `violations=${JSON.stringify(v)}`,
    );
  }

  // host_ip 0.0.0.0
  {
    const bad = deepClone(base);
    for (const svc of Object.values(bad.services ?? {})) {
      for (const p of svc.ports ?? []) {
        if (p && typeof p === 'object') p.host_ip = '0.0.0.0';
      }
    }
    const v = validateProductionCompose(bad, sandboxForValidate);
    check(
      v.some((x) => /host_ip|0\.0\.0\.0|loopback/i.test(x)),
      'negative: host_ip 0.0.0.0 rejected',
      `violations=${JSON.stringify(v)}`,
    );
  }

  // published 7860 same as sandbox
  {
    const bad = deepClone(base);
    for (const svc of Object.values(bad.services ?? {})) {
      for (const p of svc.ports ?? []) {
        if (p && typeof p === 'object') p.published = String(SANDBOX_PORT);
      }
    }
    const v = validateProductionCompose(bad, sandboxForValidate);
    check(
      v.some((x) => /7860|collides|sandbox/i.test(x)),
      'negative: published 7860 (sandbox port) rejected',
      `violations=${JSON.stringify(v)}`,
    );
  }

  // OPENAI_API_KEY=sk-test123
  {
    const bad = deepClone(base);
    const first = Object.values(bad.services ?? {})[0];
    if (first) {
      const env = envAsRecord(first.environment);
      env.OPENAI_API_KEY = 'sk-test123';
      first.environment = env;
    }
    const v = validateProductionCompose(bad, sandboxForValidate);
    check(
      v.some((x) => /OPENAI_API_KEY|sk-/i.test(x)),
      'negative: OPENAI_API_KEY=sk-test123 rejected',
      `violations=${JSON.stringify(v)}`,
    );
  }

  // ANTHROPIC_API_KEY
  {
    const bad = deepClone(base);
    const first = Object.values(bad.services ?? {})[0];
    if (first) {
      const env = envAsRecord(first.environment);
      env.ANTHROPIC_API_KEY = 'sk-ant-test-key-not-real';
      first.environment = env;
    }
    const v = validateProductionCompose(bad, sandboxForValidate);
    check(
      v.some((x) => /ANTHROPIC_API_KEY|sk-/i.test(x)),
      'negative: ANTHROPIC_API_KEY rejected',
      `violations=${JSON.stringify(v)}`,
    );
  }

  // shared sandbox volume
  {
    const bad = deepClone(base);
    const first = Object.values(bad.services ?? {})[0];
    if (first) {
      first.volumes = [
        {
          type: 'volume',
          source: 'aios_langflow_sandbox',
          target: '/app/langflow',
        },
      ];
      if (!bad.volumes) bad.volumes = {};
      (bad.volumes as Record<string, unknown>).aios_langflow_sandbox = {};
    }
    const v = validateProductionCompose(bad, sandboxForValidate);
    check(
      v.some((x) => /aios_langflow_sandbox|volume|volumes/i.test(x)),
      'negative: shared aios_langflow_sandbox volume rejected',
      `violations=${JSON.stringify(v)}`,
    );
  }

  // bind mount ../aios-data
  {
    const bad = deepClone(base);
    const first = Object.values(bad.services ?? {})[0];
    if (first) {
      first.volumes = [
        {
          type: 'bind',
          source: '../aios-data',
          target: '/data',
        },
      ];
    }
    const v = validateProductionCompose(bad, sandboxForValidate);
    check(
      v.some((x) => /aios-data|volume|bind|forbidden/i.test(x)),
      'negative: ../aios-data bind mount rejected',
      `violations=${JSON.stringify(v)}`,
    );
  }

  // cap_drop without ALL
  {
    const bad = deepClone(base);
    for (const svc of Object.values(bad.services ?? {})) {
      svc.cap_drop = ['NET_RAW'];
    }
    const v = validateProductionCompose(bad, sandboxForValidate);
    check(
      v.some((x) => /cap_drop|ALL/i.test(x)),
      'negative: cap_drop without ALL rejected',
      `violations=${JSON.stringify(v)}`,
    );
  }

  // remove tmpfs
  {
    const bad = deepClone(base);
    for (const svc of Object.values(bad.services ?? {})) {
      delete (svc as { tmpfs?: unknown }).tmpfs;
    }
    const v = validateProductionCompose(bad, sandboxForValidate);
    check(
      v.some((x) => /tmpfs/i.test(x)),
      'negative: missing tmpfs rejected',
      `violations=${JSON.stringify(v)}`,
    );
  }

  // remove resource limits
  {
    const bad = deepClone(base);
    for (const svc of Object.values(bad.services ?? {})) {
      delete (svc as { deploy?: unknown }).deploy;
      delete (svc as { mem_limit?: unknown }).mem_limit;
      delete (svc as { cpus?: unknown }).cpus;
    }
    const v = validateProductionCompose(bad, sandboxForValidate);
    check(
      v.some((x) => /resource|limits|mem_limit|cpus/i.test(x)),
      'negative: missing resource limits rejected',
      `violations=${JSON.stringify(v)}`,
    );
  }

  // image latest
  {
    const bad = deepClone(base);
    for (const svc of Object.values(bad.services ?? {})) {
      svc.image = 'langflowai/langflow:latest';
    }
    const v = validateProductionCompose(bad, sandboxForValidate);
    check(
      v.some((x) => /latest|image|pin/i.test(x)),
      'negative: image :latest rejected',
      `violations=${JSON.stringify(v)}`,
    );
  }

  // default compose isolation
  check(existsSync(DEFAULT_COMPOSE), 'default docker-compose.yml exists', 'missing');
  if (existsSync(DEFAULT_COMPOSE) && sandboxCfg) {
    try {
      const defaultCfg = composeConfigJson(DEFAULT_COMPOSE);
      const defaultName = defaultCfg.name ?? '';
      check(
        defaultName !== EXPECTED_PROJECT && defaultName !== SANDBOX_PROJECT,
        'production project name ≠ default compose project scope',
        `production=${EXPECTED_PROJECT} default=${JSON.stringify(defaultName)}`,
      );
    } catch (e) {
      fail(
        'default compose project name',
        e instanceof Error ? e.message : String(e),
      );
    }
  }
}

// ─── B. Live tests ───────────────────────────────────────────────────────────

async function durableCounts(): Promise<Record<string, number>> {
  const [flowArtifact, runtimeDeployment, skill, user] = await Promise.all([
    prisma.flowArtifact.count(),
    prisma.runtimeDeployment.count(),
    prisma.skill.count(),
    prisma.user.count(),
  ]);
  return { flowArtifact, runtimeDeployment, skill, user };
}

async function runLiveTestsAsync(): Promise<void> {
  console.log('\n=== B. Live isolation tests ===\n');

  const avail = dockerAvailable();
  if (!avail.ok) {
    blocked('live', `docker unavailable — ${avail.reason}`);
    return;
  }

  if (!existsSync(PRODUCTION_COMPOSE)) {
    blocked('live', `production compose file missing: ${PRODUCTION_COMPOSE}`);
    // Missing compose is already a contract FAIL; live stays BLOCKED (not fake-pass).
    return;
  }

  const sandboxWasRunning = containerRunning(SANDBOX_CONTAINER);
  pass(
    'sandbox container pre-state recorded',
    sandboxWasRunning ? 'running' : 'not running',
  );

  const secret = dummySecret();
  const apiKey = dummySecret();
  const superuserPassword = dummySecret();
  const composeEnv = {
    ...process.env,
    AIOS_LANGFLOW_PRODUCTION_SECRET_KEY: secret,
    AIOS_LANGFLOW_PRODUCTION_API_KEY: apiKey,
    AIOS_LANGFLOW_PRODUCTION_SUPERUSER_PASSWORD: superuserPassword,
  };
  const composeArgs = ['compose', '-f', PRODUCTION_COMPOSE];
  let started = false;
  let countsBefore: Record<string, number> | null = null;

  try {
    try {
      countsBefore = await durableCounts();
      pass('AIOS durable row counts recorded (before)', JSON.stringify(countsBefore));
    } catch (e) {
      fail(
        'AIOS durable row counts recorded (before)',
        e instanceof Error ? e.message : String(e),
      );
    }

    console.log('… docker compose up -d --wait (timeout up to 8 min)');
    try {
      execFileSync('docker', [...composeArgs, 'up', '-d', '--wait'], {
        encoding: 'utf8',
        cwd: WEB_OS_ROOT,
        env: composeEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 480_000,
        maxBuffer: 20 * 1024 * 1024,
      });
      started = true;
      pass('docker compose up -d --wait');
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string; message?: string };
      const detail = [err.stderr, err.stdout, err.message]
        .filter(Boolean)
        .join('\n')
        .slice(0, 800);
      fail('docker compose up -d --wait', detail);
      return;
    }

    // Health
    try {
      const res = await fetch('http://127.0.0.1:7861/health');
      check(res.status === 200, 'GET http://127.0.0.1:7861/health → 200', `HTTP ${res.status}`);
    } catch (e) {
      fail(
        'GET http://127.0.0.1:7861/health → 200',
        e instanceof Error ? e.message : String(e),
      );
    }

    // docker inspect hardening
    try {
      const inspectRaw = execFileSync('docker', ['inspect', CONTAINER_NAME], {
        encoding: 'utf8',
      });
      const inspect = JSON.parse(inspectRaw) as Array<{
        HostConfig?: {
          ReadonlyRootfs?: boolean;
          CapDrop?: string[] | null;
          SecurityOpt?: string[] | null;
          Binds?: string[] | null;
        };
        Mounts?: Array<{ Type?: string; Name?: string; Source?: string }>;
        NetworkSettings?: {
          Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
          Networks?: Record<string, unknown>;
        };
      }>;
      const info = inspect[0];
      check(
        info?.HostConfig?.ReadonlyRootfs === true,
        'inspect ReadonlyRootfs===true',
        `got ${String(info?.HostConfig?.ReadonlyRootfs)}`,
      );
      const capDrop = (info?.HostConfig?.CapDrop ?? []).map((c) => c.toUpperCase());
      check(
        capDrop.includes('ALL'),
        'inspect CapDrop includes ALL',
        `got ${JSON.stringify(capDrop)}`,
      );
      const secOpt = info?.HostConfig?.SecurityOpt ?? [];
      check(
        secOpt.some((s) => String(s).includes('no-new-privileges')),
        'inspect SecurityOpt includes no-new-privileges',
        `got ${JSON.stringify(secOpt)}`,
      );
      const mounts = info?.Mounts ?? [];
      const namedVolumes = mounts.filter((m) => m.Type === 'volume');
      check(
        namedVolumes.length === 0,
        'inspect Mounts: no named volumes (tmpfs only)',
        `named=${JSON.stringify(namedVolumes)}`,
      );
      const ports = info?.NetworkSettings?.Ports ?? {};
      let allLoopback = true;
      for (const bindings of Object.values(ports)) {
        if (!bindings) continue;
        for (const b of bindings) {
          if (b.HostIp && b.HostIp !== '127.0.0.1') allLoopback = false;
        }
      }
      check(allLoopback, 'inspect port bindings all 127.0.0.1', JSON.stringify(ports));

      const nets = Object.keys(info?.NetworkSettings?.Networks ?? {});
      check(
        nets.every((n) => n !== SANDBOX_NET && !n.includes('sandbox')),
        'production network ≠ sandbox network',
        `nets=${JSON.stringify(nets)}`,
      );
    } catch (e) {
      fail(
        'docker inspect hardening',
        e instanceof Error ? e.message : String(e),
      );
    }

    // read-only rootfs probe
    try {
      execFileSync(
        'docker',
        ['exec', CONTAINER_NAME, 'touch', '/probe-should-fail'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 },
      );
      fail('touch /probe-should-fail must fail (readonly rootfs)', 'command succeeded');
    } catch {
      pass('touch /probe-should-fail must fail (readonly rootfs)');
    }

    // no new named volume for production
    try {
      const volLs = execFileSync('docker', ['volume', 'ls', '--format', '{{.Name}}'], {
        encoding: 'utf8',
      });
      const lines = volLs.split(/\r?\n/).filter(Boolean);
      const prodNamed = lines.filter(
        (n) =>
          /langflow.production|aios-langflow-production/i.test(n) &&
          !/sandbox/i.test(n),
      );
      // Production must not create durable named volumes
      check(
        prodNamed.length === 0,
        'docker volume ls: no production named volumes created',
        `found ${prodNamed.join(', ')}`,
      );
    } catch (e) {
      fail(
        'docker volume ls production check',
        e instanceof Error ? e.message : String(e),
      );
    }

    // stop/rebuild/data-isolation drill
    console.log('… stop/rebuild data-isolation drill');
    try {
      execFileSync('docker', [...composeArgs, 'down'], {
        encoding: 'utf8',
        cwd: WEB_OS_ROOT,
        env: composeEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      });
      started = false;
      pass('compose down (mid-drill)');

      execFileSync('docker', [...composeArgs, 'up', '-d', '--wait'], {
        encoding: 'utf8',
        cwd: WEB_OS_ROOT,
        env: composeEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 480_000,
        maxBuffer: 20 * 1024 * 1024,
      });
      started = true;
      pass('compose up -d --wait (rebuild)');

      if (countsBefore) {
        const countsAfter = await durableCounts();
        const same =
          countsAfter.flowArtifact === countsBefore.flowArtifact &&
          countsAfter.runtimeDeployment === countsBefore.runtimeDeployment &&
          countsAfter.skill === countsBefore.skill &&
          countsAfter.user === countsBefore.user;
        check(
          same,
          'AIOS durable row counts unchanged after container rebuild',
          `before=${JSON.stringify(countsBefore)} after=${JSON.stringify(countsAfter)}`,
        );
      }
    } catch (e) {
      fail(
        'stop/rebuild data-isolation drill',
        e instanceof Error ? e.message : String(e),
      );
    }
  } finally {
    // Always tear down production compose
    try {
      execFileSync('docker', [...composeArgs, 'down'], {
        encoding: 'utf8',
        cwd: WEB_OS_ROOT,
        env: composeEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      });
      pass('docker compose down (cleanup)');
    } catch (e) {
      if (started) {
        fail(
          'docker compose down (cleanup)',
          e instanceof Error ? e.message : String(e),
        );
      }
    }

    // Must not disturb sandbox
    const sandboxNow = containerRunning(SANDBOX_CONTAINER);
    check(
      sandboxNow === sandboxWasRunning,
      'sandbox container state unchanged (not stopped/shared)',
      `before=${sandboxWasRunning} after=${sandboxNow}`,
    );
  }
}

async function main(): Promise<void> {
  console.log('Ticket 17 — Langflow Production Runtime isolation tests');
  console.log(`WEB_OS_ROOT=${WEB_OS_ROOT}`);
  console.log(`PRODUCTION_COMPOSE=${PRODUCTION_COMPOSE}`);
  console.log(`SANDBOX_COMPOSE=${SANDBOX_COMPOSE}`);

  runContractTests();
  await runLiveTestsAsync();

  console.log(
    `\n=== summary: ${passed} passed, ${failed} failed ${
      failed === 0 ? '(GREEN)' : '(RED)'
    } ===`,
  );
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error('FATAL', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
