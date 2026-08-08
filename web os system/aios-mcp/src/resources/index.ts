// Aggregator: registers every resource module onto the McpServer.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HttpClient } from '../http/client.js';
import { registerAgentResources } from './agents.js';
import { registerSkillResources } from './skills.js';
import { registerWorkflowResources } from './workflows.js';
import { registerMemoryResources } from './memory.js';
import { registerSystemResources } from './system.js';
import { registerAgentBuilderResources } from './agentbuilder.js';

export function registerAllResources(server: McpServer, client: HttpClient): void {
  registerAgentResources(server, client);
  registerSkillResources(server, client);
  registerWorkflowResources(server, client);
  registerMemoryResources(server, client);
  registerSystemResources(server, client);
  registerAgentBuilderResources(server, client);
}

/** Least-privilege resources for ChatGPT/Claude/Codex/Cursor Agent building. */
export function registerBuilderResources(server: McpServer, client: HttpClient): void {
  registerAgentBuilderResources(server, client);
}
