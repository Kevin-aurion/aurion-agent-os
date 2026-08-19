// Resource: aios-skill://{skillId}.
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HttpClient } from '../http/client.js';
import type { Skill } from '../types.js';
import { jsonResource, variable } from './util.js';

export function registerSkillResources(server: McpServer, client: HttpClient): void {
  server.registerResource(
    'skill',
    new ResourceTemplate('aios-skill://{skillId}', { list: undefined }),
    {
      title: 'AIOS skill definition',
      description:
        "Mirrors GET /api/skills/:id — a skill's full contentMd body, so a client can pull in the exact prompt/definition of a capability as context.",
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const skillId = variable(variables, 'skillId');
      return jsonResource(uri, await client.get<Skill>(`/api/skills/${encodeURIComponent(skillId)}`));
    },
  );
}
