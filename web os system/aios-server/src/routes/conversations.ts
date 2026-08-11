// Chat conversations with an agent: REST CRUD + WS req handler ('chat.send')
// that both funnel into the same send-message logic, which persists the user
// message, kicks off an ad-hoc agent run, and (async) persists+publishes the reply.
//
// Privacy (fail-closed): each conversation belongs to conversation.userId.
// List / read / send only for the authenticated owner (req.user.sub / conn.userId).
import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import { requireAuth } from '../lib/guard.js';
import { ok, errors, sendError } from '../lib/http.js';
import { prisma } from '../lib/db.js';
import { hub } from '../ws/hub.js';
import { audit } from '../lib/audit.js';

interface SendMessageResult {
  messageId: string;
  runId: string | null;
}

/** Given a settled run outcome (or a caught error), persist the AGENT/SYSTEM
 * reply message and publish it over the hub. */
async function persistAndPublishReply(
  conversationId: string,
  userId: string,
  outcomeOrError: unknown,
  isError: boolean,
) {
  if (isError) {
    const message = outcomeOrError instanceof Error ? outcomeOrError.message : String(outcomeOrError);
    const agentMessage = await prisma.message.create({
      data: { id: ulid(), conversationId, role: 'SYSTEM', content: `Agent run failed: ${message}` },
    });
    hub.publishToUser(userId, 'chat.message', {
      conversationId,
      messageId: agentMessage.id,
      role: 'SYSTEM',
      content: agentMessage.content,
      createdAt: agentMessage.createdAt,
    });
    return;
  }

  const outcome = outcomeOrError as { runId: string; results: Array<{ output?: string; ok?: boolean }> };
  // The agent's answer is the text output of the last step (not the RunOutcome
  // wrapper). Prefer the last successful step's output, else the last one.
  const lastOk = [...(outcome.results ?? [])].reverse().find((r) => r.ok && typeof r.output === 'string');
  const replyText = (lastOk?.output ?? outcome.results?.at(-1)?.output ?? '(no output)').trim();

  const agentMessage = await prisma.message.create({
    data: { id: ulid(), conversationId, role: 'AGENT', content: replyText, runId: outcome.runId },
  });
  hub.publishToUser(userId, 'chat.message', {
    conversationId,
    messageId: agentMessage.id,
    role: 'AGENT',
    content: replyText,
    runId: outcome.runId,
    createdAt: agentMessage.createdAt,
  });
}

/**
 * Persist the user message, publish it, and kick off an ad-hoc agent run in
 * the background. Enforces conversation ownership: conversation.userId must
 * equal the authenticated userId (REST or WS).
 */
async function sendMessage(
  conversationId: string,
  content: string,
  userId: string | null | undefined,
): Promise<SendMessageResult> {
  if (!userId) throw errors.unauthorized();

  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation || conversation.deletedAt) throw errors.notFound('Conversation not found');
  // Fail-closed privacy: do not leak existence of another user's thread.
  if (conversation.userId !== userId) throw errors.notFound('Conversation not found');

  // Gather recent conversation history (before this new turn) so the agent has
  // memory of the dialogue — a chat feature needs prior turns as context.
  const priorMessages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  const history = priorMessages
    .reverse()
    .map((m) => ({ role: m.role, content: m.content }));

  const userMessage = await prisma.message.create({
    data: { id: ulid(), conversationId, role: 'USER', content },
  });

  hub.publishToUser(userId, 'chat.message', {
    conversationId,
    messageId: userMessage.id,
    role: 'USER',
    content,
    createdAt: userMessage.createdAt,
  });

  // Pre-generate the run id so the client can subscribe/poll immediately while
  // the run executes asynchronously. Guard against the engine import/execution
  // failing — never blocks the response, never throws out of this function.
  const runId = ulid();
  (async () => {
    // If this agent has a keyword-triggered workflow matching the message,
    // let that workflow run drive the reply instead of the ad-hoc chat step
    // (same RunOutcome shape either way, so persistAndPublishReply below
    // doesn't need to know which path produced it).
    const { findKeywordWorkflows } = await import('../workflow/triggers.js');
    const matches = await findKeywordWorkflows(content, conversation.agentId);
    const firstMatch = matches[0];
    if (firstMatch) {
      const { runWorkflow } = await import('../workflow/runner.js');
      return runWorkflow(firstMatch.id, { message: content, conversationId }, `chat:${conversationId}`, runId);
    }

    // Cloud file targets are synced into the agent workspace by the engine
    // itself (data/cloud-files.md) — every run path gets them, so no inline
    // prompt augmentation is needed here anymore.
    const { runAgent } = await import('../engine/index.js');
    return runAgent({
      runId,
      agentId: conversation.agentId,
      input: { message: content, conversationId, history },
      triggeredBy: `chat:${conversationId}`,
    });
  })()
    .then((outcome) => persistAndPublishReply(conversationId, userId, outcome, false))
    .catch((e) => persistAndPublishReply(conversationId, userId, e, true));

  return { messageId: userMessage.id, runId };
}

export async function conversationRoutes(app: FastifyInstance) {
  app.get('/api/agents/:agentId/conversations', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { agentId } = req.params as { agentId: string };
      const userId = req.user?.sub;
      if (!userId) throw errors.unauthorized();

      // Only the caller's own threads for this agent.
      const conversations = await prisma.conversation.findMany({
        where: { agentId, userId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      return reply.send(ok(conversations));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/agents/:agentId/conversations', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { agentId } = req.params as { agentId: string };
      const body = (req.body ?? {}) as { title?: string };

      const agent = await prisma.agent.findUnique({ where: { id: agentId } });
      if (!agent) throw errors.notFound('Agent not found');

      const userId = req.user?.sub;
      if (!userId) throw errors.unauthorized();

      const conversation = await prisma.conversation.create({
        data: { id: ulid(), agentId, userId, title: body.title },
      });

      await audit(userId, 'conversation.create', 'Conversation', conversation.id);
      return reply.send(ok(conversation));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get('/api/conversations/:id/messages', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const userId = req.user?.sub;
      if (!userId) throw errors.unauthorized();

      const conversation = await prisma.conversation.findUnique({ where: { id } });
      if (!conversation || conversation.deletedAt) throw errors.notFound('Conversation not found');
      if (conversation.userId !== userId) throw errors.notFound('Conversation not found');

      const messages = await prisma.message.findMany({
        where: { conversationId: id },
        orderBy: { createdAt: 'asc' },
      });
      return reply.send(ok(messages));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/conversations/:id/messages', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { content?: string };
      if (!body.content || typeof body.content !== 'string') {
        throw errors.badRequest('content is required');
      }

      const userId = req.user?.sub;
      if (!userId) throw errors.unauthorized();

      const result = await sendMessage(id, body.content, userId);
      return reply.send(ok(result));
    } catch (e) {
      return sendError(reply, e);
    }
  });
}

// Register the WS req handler so clients can send a chat message over the
// socket too (same underlying logic as the REST endpoint — ownership via conn.userId).
hub.onReq('chat.send', async (payload: { conversationId?: string; content?: string }, conn) => {
  const { conversationId, content } = payload ?? {};
  if (!conversationId || typeof conversationId !== 'string') throw errors.badRequest('conversationId is required');
  if (!content || typeof content !== 'string') throw errors.badRequest('content is required');
  return sendMessage(conversationId, content, conn.userId);
});
