// Tools: recording_start / recording_status / recording_stop / recording_compile_skill.
// Thin wrappers over aios-server REST — all governance stays on the backend.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HttpClient } from '../http/client.js';
import { runTool } from './util.js';

export function registerRecordingTools(server: McpServer, client: HttpClient): void {
  server.registerTool(
    'recording_start',
    {
      title: 'Start desktop recording',
      description:
        'Start a server-owned Record & Replay desktop capture session. Returns an opaque sessionId. Host-global: only one active recorder at a time. Draft capture only — never auto-confirms a skill.',
      inputSchema: {},
    },
    async () => runTool(() => client.post('/api/recording/start')),
  );

  server.registerTool(
    'recording_status',
    {
      title: 'Recording status',
      description:
        'Read the status of the current/most-recent recording session for the authenticated user. Read-only. Never exposes raw filesystem paths — only opaque ids and status.',
      inputSchema: {},
    },
    async () => runTool(() => client.get('/api/recording/status')),
  );

  server.registerTool(
    'recording_stop',
    {
      title: 'Stop desktop recording',
      description:
        'Stop the active recording owned by the authenticated user. Idempotent — stopping an already-stopped session returns the same opaque artifactId without producing a new artifact.',
      inputSchema: {},
    },
    async () => runTool(() => client.post('/api/recording/stop')),
  );

  server.registerTool(
    'recording_compile_skill',
    {
      title: 'Compile recording into a draft skill',
      description:
        "Compile the authenticated user's most recent stopped recording into an INERT skill draft for the given agent. Delegates to Codex record-and-replay + skill-creator on the server; the draft is redacted and stops at AWAITING_USER_CONFIRM. Idempotent — recompiling the same session returns the same skillId. Never auto-confirms; FDE confirmation is required to make it effective. Accepts only an opaque agentId and an optional hint — never a file path.",
      inputSchema: {
        agentId: z.string().min(1),
        hint: z.string().optional(),
      },
    },
    async ({ agentId, hint }) =>
      runTool(() =>
        client.post(`/api/agents/${encodeURIComponent(agentId)}/recording/to-skill`, {
          body: hint ? { hint } : {},
        }),
      ),
  );
}
