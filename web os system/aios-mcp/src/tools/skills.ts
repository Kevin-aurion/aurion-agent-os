// Tools: list_skills, get_skill.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HttpClient } from '../http/client.js';
import type { Skill } from '../types.js';
import { runTool } from './util.js';

export function registerSkillTools(server: McpServer, client: HttpClient): void {
  server.registerTool(
    'list_skills',
    {
      title: 'List skills',
      description:
        'List all non-deleted skills in the system (name, kind, origin, reviewStatus, executionEnv).',
      inputSchema: {},
    },
    async () => runTool(() => client.get<Skill[]>('/api/skills')),
  );

  server.registerTool(
    'get_skill',
    {
      title: 'Get skill',
      description:
        "Get one skill's full definition including its contentMd (the actual prompt/markdown body that defines the capability) and review status.",
      inputSchema: { skillId: z.string().min(1) },
    },
    async ({ skillId }) =>
      runTool(() => client.get<Skill>(`/api/skills/${encodeURIComponent(skillId)}`)),
  );
}
