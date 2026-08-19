// Tools: list_conversations, list_messages, converse_with_agent (2-call compose of real endpoints).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HttpClient } from '../http/client.js';
import type { Conversation, Message } from '../types.js';
import { runTool } from './util.js';

export function registerConversationTools(server: McpServer, client: HttpClient): void {
  server.registerTool(
    'list_conversations',
    {
      title: 'List conversations',
      description: 'List existing chat conversations with one agent.',
      inputSchema: { agentId: z.string().min(1) },
    },
    async ({ agentId }) =>
      runTool(() =>
        client.get<Conversation[]>(`/api/agents/${encodeURIComponent(agentId)}/conversations`),
      ),
  );

  server.registerTool(
    'list_messages',
    {
      title: 'List messages',
      description: 'Read the full message history (user/agent/system) of one conversation.',
      inputSchema: { conversationId: z.string().min(1) },
    },
    async ({ conversationId }) =>
      runTool(() =>
        client.get<Message[]>(`/api/conversations/${encodeURIComponent(conversationId)}/messages`),
      ),
  );

  server.registerTool(
    'converse_with_agent',
    {
      title: 'Converse with agent',
      description:
        'Send a chat message to an agent and get back the ids needed to fetch its reply (the reply is generated asynchronously via runAgent or a keyword-workflow dispatch, then appended to the conversation). If conversationId is omitted, a new conversation is created first. Follow up with list_messages or get_run(runId) to read the actual reply once ready.',
      inputSchema: {
        agentId: z.string().min(1),
        content: z.string().min(1),
        conversationId: z.string().min(1).optional(),
        title: z.string().optional(),
      },
    },
    async ({ agentId, content, conversationId, title }) =>
      runTool(async () => {
        let convId = conversationId;
        let createdConversation = false;
        if (!convId) {
          const conversation = await client.post<Conversation>(
            `/api/agents/${encodeURIComponent(agentId)}/conversations`,
            { body: title !== undefined ? { title } : {} },
          );
          convId = conversation.id;
          createdConversation = true;
        }
        const result = await client.post<{ messageId: string; runId: string | null }>(
          `/api/conversations/${encodeURIComponent(convId)}/messages`,
          { body: { content } },
        );
        return {
          conversationId: convId,
          createdConversation,
          messageId: result.messageId,
          runId: result.runId,
          note: 'The agent reply is generated asynchronously. Poll list_messages(conversationId) for the AGENT reply, or get_run(runId) for execution detail.',
        };
      }),
  );
}
