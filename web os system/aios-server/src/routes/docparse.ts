import type { FastifyInstance } from 'fastify';
import { writeFile, unlink, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { requireAuth } from '../lib/guard.js';
import { ok, errors, sendError } from '../lib/http.js';
import { docparseHealthy, parseDocumentFile } from '../lib/docparse.js';

export async function docparseRoutes(app: FastifyInstance) {
  app.get('/api/docparse/health', { preHandler: requireAuth }, async (_req, reply) => {
    try {
      return ok({ healthy: await docparseHealthy() });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // Optional: multipart upload → parse. @fastify/multipart is already registered.
  app.post('/api/docparse/file', { preHandler: requireAuth }, async (req, reply) => {
    let tmpDir: string | undefined;
    let tmpPath: string | undefined;
    try {
      const file = await req.file();
      if (!file) throw errors.badRequest('No file uploaded (expected multipart field)');

      const filename = file.filename || 'document';
      const buf = await file.toBuffer();
      tmpDir = await mkdtemp(path.join(os.tmpdir(), 'aios-docparse-'));
      tmpPath = path.join(tmpDir, path.basename(filename));
      await writeFile(tmpPath, buf);

      const result = await parseDocumentFile(tmpPath, filename);
      return ok({ status: result.status, markdown: result.markdown, ir: result.ir });
    } catch (e) {
      return sendError(reply, e);
    } finally {
      if (tmpPath) {
        try {
          await unlink(tmpPath);
        } catch {
          /* ignore */
        }
      }
    }
  });
}
