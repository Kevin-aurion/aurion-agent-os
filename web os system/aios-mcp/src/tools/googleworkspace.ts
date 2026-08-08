// Google Workspace MCP tools. OAuth secrets remain inside aios-server; this
// provider sends only user-scoped business arguments to governed REST routes.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HttpClient } from '../http/client.js';
import { runTool } from './util.js';

const accountId = z.string().min(1).optional().describe('Optional Google ConnectedAccount id; defaults to the first connected Google account');
const runId = z.string().min(1).describe('A real AIOS Run id with an APPROVED ApprovalRequest');

export function registerGoogleWorkspaceTools(server: McpServer, client: HttpClient): void {
  server.registerTool(
    'google_workspace_status',
    {
      title: 'Google Workspace connection status',
      description:
        'List the authenticated AIOS user’s Google connections and granted scopes. Read-only; never returns OAuth tokens.',
      inputSchema: {},
    },
    async () => runTool(() => client.get('/api/google-workspace/status')),
  );

  server.registerTool(
    'gmail_search',
    {
      title: 'Search Gmail',
      description:
        'Search Gmail with standard Gmail query syntax. Returns metadata/snippets only and performs no write.',
      inputSchema: {
        accountId,
        query: z.string().max(500).optional().describe('Example: from:vendor@example.com newer_than:30d'),
      },
    },
    async (args) => runTool(() => client.post('/api/google-workspace/gmail/search', { body: args })),
  );

  server.registerTool(
    'gmail_get_message',
    {
      title: 'Read one Gmail message',
      description:
        'Read one Gmail message body and attachment names by message id. Read-only; large bodies are truncated.',
      inputSchema: {
        accountId,
        messageId: z.string().min(1),
        maxChars: z.number().int().min(1_000).max(100_000).optional(),
      },
    },
    async (args) => runTool(() => client.post('/api/google-workspace/gmail/message', { body: args })),
  );

  server.registerTool(
    'drive_search',
    {
      title: 'Search Google Drive',
      description:
        'Search the connected Google Drive by name/full text. Returns file metadata only and performs no write.',
      inputSchema: {
        accountId,
        query: z.string().max(500).default(''),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async (args) => runTool(() => client.post('/api/google-workspace/drive/search', { body: args })),
  );

  server.registerTool(
    'drive_read_text',
    {
      title: 'Read Google Drive text',
      description:
        'Read text, Google Docs, or Google Sheets content by file id. Binary Office/PDF files must use AIOS document sync + Docling.',
      inputSchema: {
        accountId,
        fileId: z.string().min(1),
        maxChars: z.number().int().min(1_000).max(100_000).optional(),
      },
    },
    async (args) => runTool(() => client.post('/api/google-workspace/drive/read-text', { body: args })),
  );

  server.registerTool(
    'gmail_create_draft',
    {
      title: 'Create Gmail draft',
      description:
        'Create (but do not send) a Gmail draft. Fail-closed: FDE role, cloudWrite permission, and a real approved Run are all required.',
      inputSchema: {
        accountId,
        runId,
        to: z.string().email(),
        cc: z.string().email().optional(),
        subject: z.string().min(1).max(500),
        body: z.string().min(1).max(500_000),
      },
    },
    async (args) => runTool(() => client.post('/api/google-workspace/gmail/draft', { body: args })),
  );

  server.registerTool(
    'gmail_send',
    {
      title: 'Send Gmail',
      description:
        'Send one Gmail message. High-risk and fail-closed: FDE role, sendEmail permission, and a real approved Run are all required.',
      inputSchema: {
        accountId,
        runId,
        to: z.string().email(),
        subject: z.string().min(1).max(500),
        body: z.string().min(1).max(500_000),
      },
    },
    async (args) => runTool(() => client.post('/api/google-workspace/gmail/send', { body: args })),
  );

  server.registerTool(
    'drive_create_text_file',
    {
      title: 'Create Google Drive text file',
      description:
        'Create one UTF-8 text/Markdown file in Drive. Fail-closed: FDE role, cloudWrite permission, and a real approved Run are required.',
      inputSchema: {
        accountId,
        runId,
        name: z.string().min(1).max(240),
        content: z.string().max(2_000_000),
        folderId: z.string().min(1).optional(),
        mimeType: z.enum(['text/plain', 'text/markdown']).optional(),
      },
    },
    async (args) => runTool(() => client.post('/api/google-workspace/drive/create-text', { body: args })),
  );
}
