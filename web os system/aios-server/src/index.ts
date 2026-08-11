import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import fs from 'node:fs';
import { config, paths } from './config.js';
import { prisma } from './lib/db.js';
import { hub } from './ws/hub.js';
import { sendError } from './lib/http.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { mcpOAuthRoutes } from './routes/mcpoauth.js';
import { agentRoutes } from './routes/agents.js';
import { skillRoutes } from './routes/skills.js';
import { evalRoutes } from './routes/evals.js';
import { runtimeRoutes } from './routes/runtime.js';
import { workflowRoutes } from './routes/workflows.js';
import { runRoutes } from './routes/runs.js';
import { approvalRoutes } from './routes/approvals.js';
import { proposalRoutes } from './routes/proposals.js';
import { reflectionRoutes } from './routes/reflections.js';
import { recordingRoutes } from './routes/recording.js';
import { conversationRoutes } from './routes/conversations.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { memoryRoutes } from './routes/memory.js';
import { costRoutes } from './routes/cost.js';
import { identityRoutes } from './routes/identity.js';
import { docparseRoutes } from './routes/docparse.js';
import { trainingRoutes } from './routes/training.js';
import { agentBuilderRoutes } from './routes/agentbuilder.js';
import { agentRuntimeRoutes } from './routes/agentruntime.js';
import { voiceRoutes } from './routes/voice.js';
import { mcpRoutes } from './routes/mcp.js';
import { googleWorkspaceRoutes } from './routes/googleworkspace.js';
import { a2aRoutes } from './routes/a2a.js';
import { devicesRoutes } from './routes/devices.js';
import { deviceRoutes } from './routes/device.js';
import { integrationRoutes } from './integrations/routes.js';
import { channelRoutes } from './channels/routes.js';
import { modelGatewayRoutes } from './routes/modelgateway.js';
import { knowledgeGatewayRoutes } from './routes/knowledgegateway.js';
import { knowledgePilotRoutes } from './routes/knowledgepilot.js';
import { graphRoutes } from './routes/graph.js';

const featureRoutes = [
  agentRoutes,
  skillRoutes,
  evalRoutes,
  runtimeRoutes,
  workflowRoutes,
  runRoutes,
  approvalRoutes,
  proposalRoutes,
  reflectionRoutes,
  recordingRoutes,
  conversationRoutes,
  dashboardRoutes,
  memoryRoutes,
  costRoutes,
  identityRoutes,
  docparseRoutes,
  trainingRoutes,
  agentBuilderRoutes,
  agentRuntimeRoutes,
  voiceRoutes,
  mcpRoutes,
  googleWorkspaceRoutes,
  a2aRoutes,
  devicesRoutes,
  deviceRoutes,
  integrationRoutes,
  channelRoutes,
  modelGatewayRoutes,
  knowledgeGatewayRoutes,
  knowledgePilotRoutes,
  graphRoutes,
] as const;

async function main() {
  // Ensure local data directories exist.
  for (const p of [
    paths.agents,
    paths.skills,
    paths.cache,
    paths.computerControl,
    paths.runs,
    paths.deviceArtifacts,
  ]) {
    fs.mkdirSync(p, { recursive: true });
  }

  const app = Fastify({
    logger: { level: process.env.AIOS_DEBUG ? 'debug' : 'info' },
    // Keep the raw body around for LINE webhook HMAC verification.
    bodyLimit: 25 * 1024 * 1024,
  });

  await app.register(cors, { origin: [config.webOrigin, 'http://localhost:3100'], credentials: true });
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });

  app.setErrorHandler((err, _req, reply) => sendError(reply, err));

  // ── Routes ────────────────────────────────────────────────────────────────
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(mcpOAuthRoutes);
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

async function registerFeatureRoutes(app: import('fastify').FastifyInstance) {
  // These routes are part of the production application, so register them
  // statically. A variable dynamic import works under tsx but is left pointing
  // at dist/routes/*.js by tsup, which made a healthy production server expose
  // only the bootstrap routes and silently skip the rest.
  for (const routes of featureRoutes) {
    await app.register(routes);
  }

  // Ticket 22: the web client + Next rewrite reach the backend under `/api/*`;
  // re-register the FDE registry route groups (MCP + A2A) with that prefix so
  // the dashboard panels resolve. Bare `/mcp/*` and `/a2a/*` stay as the
  // public Remote-MCP-era contract; both registrations share the exact same
  // handlers and guard functions.
  await app.register(mcpRoutes, { prefix: '/api' });
  await app.register(a2aRoutes, { prefix: '/api' });
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
