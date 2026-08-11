/**
 * Ticket 21 — Backup / restore + Langflow stateless rebuild drill (Phase 6).
 * Run:
 *   npx tsx .scratch/aios-client-langflow-platform/tests/t21-backup-restore-drill.ts
 * Optional (for full restore when aios role lacks CREATEDB):
 *   AIOS_DR_ADMIN_URL=postgresql://kaikaiwu@127.0.0.1:5433/postgres \
 *     npx tsx .scratch/aios-client-langflow-platform/tests/t21-backup-restore-drill.ts
 *
 * NEVER mutates production `aios` DB (only reads + dumps).
 * Scratch DB name MUST start with `aios_dr_drill_` or CREATE/DROP is refused.
 * Dump files go to OS tmpdir only — never into the repo.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

type StepResult = {
  name: string;
  status: 'passed' | 'failed' | 'blocked';
  elapsedMs: number;
  detail?: string;
};

const steps: StepResult[] = [];
let failed = 0;
let blocked = 0;

function record(
  name: string,
  status: StepResult['status'],
  elapsedMs: number,
  detail = '',
): void {
  steps.push({ name, status, elapsedMs, detail });
  const tag =
    status === 'passed' ? 'PASS' : status === 'blocked' ? 'BLOCKED' : 'FAIL';
  console.log(`${tag}  ${name} (${elapsedMs}ms)${detail ? ` — ${detail}` : ''}`);
  if (status === 'failed') {
    failed += 1;
    process.exitCode = 1;
  }
  if (status === 'blocked') blocked += 1;
}

function parseDatabaseUrl(url: string): {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
} {
  const u = new URL(url);
  return {
    host: u.hostname || '127.0.0.1',
    port: u.port || '5432',
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: (u.pathname.replace(/^\//, '') || 'postgres').split('?')[0] ?? 'postgres',
  };
}

/** Hard guard: only aios_dr_drill_* may be CREATE/DROP targets. */
function assertScratchDbName(name: string): void {
  const n = (name ?? '').trim();
  if (!n.startsWith('aios_dr_drill_')) {
    throw new Error(
      `refusing CREATE/DROP: db name must start with aios_dr_drill_ (got ${JSON.stringify(n)})`,
    );
  }
  if (n === 'aios' || n === 'postgres' || n.includes(';') || /\s/.test(n)) {
    throw new Error(`refusing CREATE/DROP: unsafe db name ${JSON.stringify(n)}`);
  }
  // identifier-safe
  if (!/^aios_dr_drill_[a-zA-Z0-9_]+$/.test(n)) {
    throw new Error(`refusing CREATE/DROP: invalid scratch db identifier ${n}`);
  }
}

function run(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 120_000,
): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    env,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    status: r.status,
  };
}

function psqlArgs(
  conn: { host: string; port: string; user: string },
  database: string,
  extra: string[],
): string[] {
  return [
    '-h',
    conn.host,
    '-p',
    conn.port,
    '-U',
    conn.user,
    '-d',
    database,
    ...extra,
  ];
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function pollHealth(url: string, maxMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await sleep(2000);
  }
  return false;
}

function printSummary(): void {
  const passed = steps.filter((s) => s.status === 'passed').length;
  console.log('\n── drill summary ──');
  for (const s of steps) {
    console.log(
      `  ${s.status.padEnd(8)} ${s.name.padEnd(32)} ${String(s.elapsedMs).padStart(6)}ms  ${s.detail ?? ''}`,
    );
  }
  console.log(
    `\n── total: ${passed} passed, ${failed} failed, ${blocked} blocked ──`,
  );
  if (failed > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  console.log('── t21-backup-restore-drill ──');

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const serverRoot = path.resolve(__dirname, '../../..');
  const webOsRoot = path.resolve(serverRoot, '..');

  // Dump ONLY under OS tmp — never under repo /.scratch/
  let scratchDir: string | null = null;
  try {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-dr-'));
  } catch (e) {
    record(
      'tmpdir',
      'failed',
      0,
      e instanceof Error ? e.message : String(e),
    );
    printSummary();
    return;
  }

  try {
    // Load .env for DATABASE_URL (do not override existing env)
    const envPath = path.join(serverRoot, '.env');
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!m) continue;
        let v = m[2] ?? '';
        if (
          (v.startsWith('"') && v.endsWith('"')) ||
          (v.startsWith("'") && v.endsWith("'"))
        ) {
          v = v.slice(1, -1);
        }
        if (process.env[m[1]!] == null) process.env[m[1]!] = v;
      }
    }

    const databaseUrl = process.env.DATABASE_URL ?? '';
    if (!databaseUrl) {
      record('env DATABASE_URL', 'blocked', 0, 'DATABASE_URL not set');
      printSummary();
      return;
    }
    const db = parseDatabaseUrl(databaseUrl);
    if (db.database === 'aios_dr_drill_' || db.database.startsWith('aios_dr_drill_')) {
      record(
        'env DATABASE_URL',
        'failed',
        0,
        'DATABASE_URL must point at source DB (aios), not a scratch drill DB',
      );
      printSummary();
      return;
    }
    if (db.database !== 'aios') {
      console.warn(
        `WARN: DATABASE_URL database is "${db.database}" (expected aios); dump-only of that DB, never DROP it`,
      );
    }

    // Optional admin for CREATE/restore/DROP of scratch only
    const adminUrl = (process.env.AIOS_DR_ADMIN_URL ?? '').trim();
    const admin = adminUrl ? parseDatabaseUrl(adminUrl) : null;
    if (admin) {
      console.log(
        `info: AIOS_DR_ADMIN_URL set (user=${admin.user}@${admin.host}:${admin.port}) — used only for aios_dr_drill_* CREATE/restore/DROP`,
      );
    } else {
      console.log(
        'info: AIOS_DR_ADMIN_URL unset — restore may BLOCK if aios role lacks CREATEDB',
      );
    }

    const pgDump = '/opt/homebrew/bin/pg_dump';
    const psql = '/opt/homebrew/bin/psql';
    const envSource = {
      ...process.env,
      PGPASSWORD: db.password,
      PATH: `/opt/homebrew/bin:${process.env.PATH ?? ''}`,
    };
    const envAdmin = admin
      ? {
          ...process.env,
          PGPASSWORD: admin.password || process.env.PGPASSWORD || '',
          PATH: `/opt/homebrew/bin:${process.env.PATH ?? ''}`,
        }
      : envSource;
    const ddlConn = admin ?? db;

    // ── 1. pg_dump ──────────────────────────────────────────────────────
    const dumpFile = path.join(scratchDir, 'aios-dump.sql');
    {
      const t0 = Date.now();
      if (!fs.existsSync(pgDump)) {
        record('pg_dump', 'blocked', Date.now() - t0, `${pgDump} not found`);
      } else {
        const r = run(
          pgDump,
          [
            '-h',
            db.host,
            '-p',
            db.port,
            '-U',
            db.user,
            '-d',
            db.database,
            '--no-owner',
            '--no-acl',
            '-f',
            dumpFile,
          ],
          envSource,
          180_000,
        );
        if (!r.ok || !fs.existsSync(dumpFile)) {
          record(
            'pg_dump',
            'failed',
            Date.now() - t0,
            r.stderr.slice(0, 300) || `status=${r.status}`,
          );
        } else {
          const size = fs.statSync(dumpFile).size;
          record(
            'pg_dump',
            'passed',
            Date.now() - t0,
            `bytes=${size}; path under os.tmpdir (not repo)`,
          );
        }
      }
    }

    // ── 2. restore to scratch DB + compare ──────────────────────────────
    const scratchDb = `aios_dr_drill_${Date.now()}`;
    {
      const t0 = Date.now();
      if (!fs.existsSync(dumpFile)) {
        record('restore+verify', 'blocked', Date.now() - t0, 'no dump file');
      } else if (!fs.existsSync(psql)) {
        record('restore+verify', 'blocked', Date.now() - t0, `${psql} not found`);
      } else if (!adminUrl && !admin) {
        // Try with source role first; if CREATEDB missing → BLOCKED (honest)
        try {
          assertScratchDbName(scratchDb);
        } catch (e) {
          record(
            'restore+verify',
            'failed',
            Date.now() - t0,
            e instanceof Error ? e.message : String(e),
          );
        }
      }

      if (fs.existsSync(dumpFile) && fs.existsSync(psql)) {
        try {
          assertScratchDbName(scratchDb);

          const countSql = `
SELECT 'FlowArtifact' AS t, COUNT(*)::text AS c FROM "FlowArtifact"
UNION ALL SELECT 'RuntimeDeployment', COUNT(*)::text FROM "RuntimeDeployment"
UNION ALL SELECT 'Run', COUNT(*)::text FROM "Run"
UNION ALL SELECT 'AuditLog', COUNT(*)::text FROM "AuditLog";
`;
          const parseCounts = (out: string) => {
            const m = new Map<string, number>();
            for (const line of out.trim().split('\n')) {
              const [k, v] = line.split(',');
              if (k && v != null) m.set(k.trim(), Number(v));
            }
            return m;
          };

          // Source counts — always via DATABASE_URL (read-only path)
          const srcCounts = run(
            psql,
            psqlArgs(db, db.database, ['-t', '-A', '-F', ',', '-c', countSql]),
            envSource,
          );
          if (!srcCounts.ok) {
            throw new Error(
              `source counts failed: ${srcCounts.stderr.slice(0, 200)}`,
            );
          }
          const srcMap = parseCounts(srcCounts.stdout);

          const digSql = `SELECT id, digest FROM "FlowArtifact" ORDER BY "createdAt" DESC LIMIT 5;`;
          const srcDig = run(
            psql,
            psqlArgs(db, db.database, ['-t', '-A', '-F', '|', '-c', digSql]),
            envSource,
          );

          // CREATE scratch — only aios_dr_drill_* (asserted)
          assertScratchDbName(scratchDb);
          const created = run(
            psql,
            psqlArgs(ddlConn, 'postgres', [
              '-v',
              'ON_ERROR_STOP=1',
              '-c',
              `CREATE DATABASE ${scratchDb};`,
            ]),
            envAdmin,
          );
          if (!created.ok) {
            const err = created.stderr.slice(0, 300);
            if (
              /permission denied|must be superuser|CREATEDB/i.test(err) &&
              !adminUrl
            ) {
              record(
                'restore+verify',
                'blocked',
                Date.now() - t0,
                `CREATE DATABASE not permitted for aios role; set AIOS_DR_ADMIN_URL for full drill: ${err.trim()}`,
              );
            } else {
              throw new Error(`CREATE DATABASE failed: ${err}`);
            }
          } else {
            // restore into scratch only
            assertScratchDbName(scratchDb);
            const restored = run(
              psql,
              psqlArgs(ddlConn, scratchDb, [
                '-v',
                'ON_ERROR_STOP=1',
                '-f',
                dumpFile,
              ]),
              envAdmin,
              300_000,
            );
            if (!restored.ok) {
              throw new Error(`restore failed: ${restored.stderr.slice(0, 400)}`);
            }

            const dstCounts = run(
              psql,
              psqlArgs(ddlConn, scratchDb, [
                '-t',
                '-A',
                '-F',
                ',',
                '-c',
                countSql,
              ]),
              envAdmin,
            );
            if (!dstCounts.ok) {
              throw new Error(
                `scratch counts failed: ${dstCounts.stderr.slice(0, 200)}`,
              );
            }
            const dstMap = parseCounts(dstCounts.stdout);

            const tables = [
              'FlowArtifact',
              'RuntimeDeployment',
              'Run',
              'AuditLog',
            ];
            const mismatches: string[] = [];
            for (const t of tables) {
              if (srcMap.get(t) !== dstMap.get(t)) {
                mismatches.push(
                  `${t}: src=${srcMap.get(t)} dst=${dstMap.get(t)}`,
                );
              }
            }

            const dstDig = run(
              psql,
              psqlArgs(ddlConn, scratchDb, [
                '-t',
                '-A',
                '-F',
                '|',
                '-c',
                digSql,
              ]),
              envAdmin,
            );
            const srcDigLines = (srcDig.stdout || '').trim();
            const dstDigLines = (dstDig.stdout || '').trim();
            if (srcDigLines !== dstDigLines) {
              mismatches.push('FlowArtifact digest sample mismatch');
            }

            // DROP scratch only
            assertScratchDbName(scratchDb);
            const dropped = run(
              psql,
              psqlArgs(ddlConn, 'postgres', [
                '-v',
                'ON_ERROR_STOP=1',
                '-c',
                `DROP DATABASE IF EXISTS ${scratchDb};`,
              ]),
              envAdmin,
            );
            if (!dropped.ok) {
              mismatches.push(
                `DROP scratch failed: ${dropped.stderr.slice(0, 120)}`,
              );
            }

            if (mismatches.length) {
              record(
                'restore+verify',
                'failed',
                Date.now() - t0,
                mismatches.join('; '),
              );
            } else {
              const digestHash = createHash('sha256')
                .update(srcDigLines)
                .digest('hex')
                .slice(0, 12);
              record(
                'restore+verify',
                'passed',
                Date.now() - t0,
                `counts match; digestSample=${digestHash}; scratch ${scratchDb} dropped`,
              );
            }
          }
        } catch (e) {
          // best-effort DROP only if name still passes guard
          try {
            assertScratchDbName(scratchDb);
            run(
              psql,
              psqlArgs(ddlConn, 'postgres', [
                '-c',
                `DROP DATABASE IF EXISTS ${scratchDb};`,
              ]),
              envAdmin,
            );
          } catch {
            /* never DROP without guard */
          }
          // Avoid double-record if already BLOCKED
          if (!steps.some((s) => s.name === 'restore+verify')) {
            record(
              'restore+verify',
              'failed',
              Date.now() - t0,
              e instanceof Error ? e.message : String(e),
            );
          }
        }
      }
    }

    // ── 3. Langflow sandbox restart ─────────────────────────────────────
    {
      const t0 = Date.now();
      const docker = run('docker', ['info'], process.env, 15_000);
      if (!docker.ok) {
        record(
          'langflow-sandbox-restart',
          'blocked',
          Date.now() - t0,
          'docker unavailable',
        );
      } else {
        const inspect = run(
          'docker',
          ['inspect', '-f', '{{.State.Status}}', 'aios-langflow-sandbox'],
          process.env,
          15_000,
        );
        if (!inspect.ok) {
          record(
            'langflow-sandbox-restart',
            'blocked',
            Date.now() - t0,
            'container aios-langflow-sandbox not found',
          );
        } else {
          const restarted = run(
            'docker',
            ['restart', 'aios-langflow-sandbox'],
            process.env,
            60_000,
          );
          if (!restarted.ok) {
            record(
              'langflow-sandbox-restart',
              'failed',
              Date.now() - t0,
              restarted.stderr.slice(0, 200),
            );
          } else {
            const healthy = await pollHealth(
              'http://127.0.0.1:7860/health',
              120_000,
            );
            if (!healthy) {
              record(
                'langflow-sandbox-restart',
                'failed',
                Date.now() - t0,
                'health not ready within 120s',
              );
            } else {
              record(
                'langflow-sandbox-restart',
                'passed',
                Date.now() - t0,
                '7860/health ok',
              );
            }
          }
        }
      }
    }

    // ── 4. Langflow production up/health/down ───────────────────────────
    {
      const t0 = Date.now();
      const composeFile = path.join(
        webOsRoot,
        'docker-compose.langflow-production.yml',
      );
      if (!fs.existsSync(composeFile)) {
        record(
          'langflow-production-rebuild',
          'blocked',
          Date.now() - t0,
          'compose file missing',
        );
      } else {
        const docker = run('docker', ['info'], process.env, 15_000);
        if (!docker.ok) {
          record(
            'langflow-production-rebuild',
            'blocked',
            Date.now() - t0,
            'docker unavailable',
          );
        } else {
          const secret = spawnSync('openssl', ['rand', '-hex', '32'], {
            encoding: 'utf8',
          });
          const secretKey =
            (secret.stdout || '').trim() || `drill-${Date.now()}`;
          const upEnv = {
            ...process.env,
            AIOS_LANGFLOW_PRODUCTION_SECRET_KEY: secretKey,
          };
          const up = run(
            'docker',
            ['compose', '-f', composeFile, 'up', '-d', '--wait'],
            upEnv,
            300_000,
          );
          if (!up.ok) {
            run(
              'docker',
              ['compose', '-f', composeFile, 'down'],
              upEnv,
              120_000,
            );
            record(
              'langflow-production-rebuild',
              'failed',
              Date.now() - t0,
              (up.stderr || up.stdout).slice(0, 300),
            );
          } else {
            const healthy = await pollHealth(
              'http://127.0.0.1:7861/health',
              120_000,
            );
            const down = run(
              'docker',
              ['compose', '-f', composeFile, 'down'],
              upEnv,
              120_000,
            );
            if (!healthy) {
              record(
                'langflow-production-rebuild',
                'failed',
                Date.now() - t0,
                '7861/health not ready',
              );
            } else if (!down.ok) {
              record(
                'langflow-production-rebuild',
                'failed',
                Date.now() - t0,
                `health ok but down failed: ${down.stderr.slice(0, 160)}`,
              );
            } else {
              record(
                'langflow-production-rebuild',
                'passed',
                Date.now() - t0,
                'up+health+down ok',
              );
            }
          }
        }
      }
    }

    printSummary();
  } finally {
    // Always wipe dump from OS tmp — never leave plaintext DB dumps around
    if (scratchDir) {
      try {
        fs.rmSync(scratchDir, { recursive: true, force: true });
        console.log(`cleanup: removed tmp dump dir ${scratchDir}`);
      } catch (e) {
        console.warn(
          'cleanup: failed to remove tmp dump dir:',
          e instanceof Error ? e.message : e,
        );
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
