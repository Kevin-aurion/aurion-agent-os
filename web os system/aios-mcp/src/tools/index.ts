// Aggregator: registers every tool module onto the McpServer.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HttpClient } from '../http/client.js';
import { registerAgentTools } from './agents.js';
import { registerSkillTools } from './skills.js';
import { registerWorkflowTools } from './workflows.js';
import { registerRunTools } from './runs.js';
import { registerConversationTools } from './conversations.js';
import { registerMemoryTools } from './memory.js';
import { registerSystemTools } from './system.js';
import { registerRecordingTools } from './recording.js';
import { registerGoogleWorkspaceTools } from './googleworkspace.js';
import { registerAgentBuilderTools } from './agentbuilder.js';

export function registerAllTools(server: McpServer, client: HttpClient): void {
  registerAgentTools(server, client);
  registerSkillTools(server, client);
  registerWorkflowTools(server, client);
  registerRunTools(server, client);
  registerConversationTools(server, client);
  registerMemoryTools(server, client);
  registerSystemTools(server, client);
  registerRecordingTools(server, client);
  registerGoogleWorkspaceTools(server, client);
  registerAgentBuilderTools(server, client);
}

/** Least-privilege surface for ChatGPT/Claude/Codex/Cursor Agent building. */
export function registerBuilderTools(server: McpServer, client: HttpClient): void {
  registerAgentBuilderTools(server, client);
}
