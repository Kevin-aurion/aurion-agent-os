import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fs from 'node:fs';
import { config, paths } from './config.js';
import { prisma } from './lib/db.js';
import { hub } from './ws/hub.js';
import { sendError } from './lib/http.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';

async function main() {
  // Ensure local data directories exist.
  for (const p of [paths.agents, paths.skills, paths.cache, paths.computerControl, paths.runs]) {
    fs.mkdirSync(p, { recursive: true });
  }

  const app = Fastify({
    logger: { level: process.env.AIOS_DEBUG ? 'debug' : 'info' },
    // Keep the raw body around for LINE webhook HMAC verification.
    bodyLimit: 25 * 1024 * 1024,
  });

  await app.register(cors, { origin: [config.webOrigin, 'http://localhost:3100'], credentials: true });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });

  app.setErrorHandler((err, _req, reply) => sendError(reply, err));

  // ── Routes ────────────────────────────────────────────────────────────────
  await app.register(healthRoutes);
  await app.register(authRoutes);
  // Later phases register here: agents, skills, workflows, runs, conversations,
  // integrations (microsoft/google), channels (line), dashboard, audit.
  await registerFeatureRoutes(app);

  // ── WebSocket hub (AWP/1) on the same server ────────────────────────────────
  await app.ready();
  hub.attach(app.server);

  // ── Scheduler (BullMQ repeatable jobs) — started if present ─────────────────
  await startSchedulerIfPresent();

  // ── Memory (Qdrant collection) — best-effort, never blocks startup ──────────
  await ensureMemoryCollectionIfPresent(app);

  await app.listen({ host: '127.0.0.1', port: config.httpPort });
  app.log.info(`AIOS server on http://127.0.0.1:${config.httpPort}  (ws: /ws)  tz=${config.tz}`);

  const shutdown = async () => {
    app.log.info('shutting down');
    hub.stop();
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Feature routes are added incrementally; import failures for not-yet-built
// modules must not crash Phase 0. Each is optional until its phase lands.
async function registerFeatureRoutes(app: import('fastify').FastifyInstance) {
  const optional: Array<[string, string]> = [
    ['./routes/agents.js', 'agentRoutes'],
    ['./routes/skills.js', 'skillRoutes'],
    ['./routes/workflows.js', 'workflowRoutes'],
    ['./routes/runs.js', 'runRoutes'],
    ['./routes/conversations.js', 'conversationRoutes'],
    ['./routes/dashboard.js', 'dashboardRoutes'],
    ['./integrations/routes.js', 'integrationRoutes'],
    ['./channels/routes.js', 'channelRoutes'],
  ];
  for (const [mod, exp] of optional) {
    try {
      const m: any = await import(mod);
      if (m[exp]) await app.register(m[exp]);
    } catch (e: any) {
      if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    }
  }
}

async function startSchedulerIfPresent() {
  try {
    const m: any = await import('./scheduler/index.js');
    if (m.startScheduler) await m.startScheduler();
  } catch (e: any) {
    if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  }
}

async function ensureMemoryCollectionIfPresent(app: import('fastify').FastifyInstance) {
  try {
    const m: any = await import('./memory/index.js');
    if (m.ensureCollection) {
      await m.ensureCollection();
      app.log.info('memory: Qdrant collection ready');
    }
  } catch (e: any) {
    app.log.warn({ err: e }, 'memory: ensureCollection failed (continuing without vector index)');
  }
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
