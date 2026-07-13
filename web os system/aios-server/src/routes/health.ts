import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config, integrationsReady } from '../config.js';
import { prisma } from '../lib/db.js';
import { hub } from '../ws/hub.js';
import { ok } from '../lib/http.js';

const pexec = promisify(execFile);

async function cliOk(path: string): Promise<{ installed: boolean; version?: string }> {
  try {
    const { stdout } = await pexec(path, ['--version'], { timeout: 5000 });
    return { installed: true, version: stdout.trim().split('\n')[0] };
  } catch {
    return { installed: false };
  }
}

export async function healthRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => {
    let db = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      db = true;
    } catch {
      /* db down */
    }
    return ok({ status: 'ok', db, wsConnections: hub.connectionCount, tz: config.tz });
  });

  // Preflight: are the host engines installed + which integrations are wired up.
  app.get('/api/preflight', async () => {
    const [claude, codex, grok] = await Promise.all([
      cliOk(config.engines.claudePath),
      cliOk(config.engines.codexPath),
      cliOk(config.engines.grokPath),
    ]);
    return ok({
      engines: { claude, codex, grok },
      integrations: {
        microsoft: integrationsReady.microsoft(),
        google: integrationsReady.google(),
        line: integrationsReady.line(),
      },
    });
  });
}
