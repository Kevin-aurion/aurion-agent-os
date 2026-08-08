// Memory REST API — list/read wiki files, semantic search, reindex.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { ok, errors } from '../lib/http.js';
import { requireAuth } from '../lib/guard.js';
import { materializeAgent } from '../engine/materialize.js';
import {
  listWikiFiles,
  readWikiFile,
  recallHits,
  reindexAgent,
} from '../memory/memoryService.js';
import { requireVisibleAgent } from '../lib/agentaccess.js';

const searchSchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().min(1).max(20).optional(),
});

export async function memoryRoutes(app: FastifyInstance) {
  // GET /api/agents/:agentId/memory/files — wiki file tree (flat list with paths)
  app.get('/api/agents/:agentId/memory/files', { preHandler: requireAuth }, async (req) => {
    const { agentId } = req.params as { agentId: string };
    await requireVisibleAgent(agentId, req.user!);
    const agentDir = await materializeAgent(agentId);
    const files = await listWikiFiles(agentDir);
    return ok({ files });
  });

  // GET /api/agents/:agentId/memory/file?path= — read one wiki file (path-traversal safe)
  app.get('/api/agents/:agentId/memory/file', { preHandler: requireAuth }, async (req) => {
    const { agentId } = req.params as { agentId: string };
    const q = req.query as { path?: string };
    if (!q.path || typeof q.path !== 'string') throw errors.badRequest('path query required');
    await requireVisibleAgent(agentId, req.user!);
    const agentDir = await materializeAgent(agentId);
    try {
      const content = await readWikiFile(agentDir, q.path);
      return ok({ path: q.path, content });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/traversal|denied/i.test(msg)) throw errors.forbidden(msg);
      throw errors.notFound(`File not found: ${q.path}`);
    }
  });

  // POST /api/agents/:agentId/memory/search — semantic recall (empty hits if no key)
  app.post('/api/agents/:agentId/memory/search', { preHandler: requireAuth }, async (req) => {
    const { agentId } = req.params as { agentId: string };
    const body = searchSchema.parse(req.body ?? {});
    await requireVisibleAgent(agentId, req.user!);
    const hits = await recallHits(agentId, body.query, body.topK ?? 4);
    return ok({ query: body.query, hits });
  });

  // POST /api/agents/:agentId/memory/reindex — scan wiki and incrementally re-embed
  app.post('/api/agents/:agentId/memory/reindex', { preHandler: requireAuth }, async (req) => {
    const { agentId } = req.params as { agentId: string };
    await requireVisibleAgent(agentId, req.user!);
    const agentDir = await materializeAgent(agentId);
    const stats = await reindexAgent(agentId, agentDir);
    return ok(stats);
  });
}
