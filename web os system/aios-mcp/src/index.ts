#!/usr/bin/env node
// aios-mcp entry point.
// Loads config, builds AuthManager + HttpClient, constructs the McpServer,
// registers all tools + resources, then starts the stdio (default) or http transport.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig } from './config.js';
import { AuthManager } from './auth/session.js';
import { FixedAccessTokenProvider } from './auth/fixed.js';
import { HttpClient } from './http/client.js';
import { registerAllTools, registerBuilderTools } from './tools/index.js';
import { registerAllResources, registerBuilderResources } from './resources/index.js';
import { registerAllPrompts } from './prompts/index.js';
import { runStdio } from './transports/stdio.js';
import { runHttp } from './transports/http.js';

const VERSION = '0.3.0';

async function main(): Promise<void> {
  const config = loadConfig();
  let localAuth: AuthManager | null = null;

  const buildServer = (client: HttpClient): McpServer => {
    const server = new McpServer(
      { name: 'aios-mcp', version: VERSION },
      {
        instructions: [
          'Use this server as the durable system of record when the user asks to build, train, revise or test an AI employee or Agent.',
          'Interview adaptively with one high-value question at a time; do not use a fixed questionnaire.',
          'Before creating a build, call list_my_agents. If continuation is ambiguous, ask which employee; if it is new, ask the user to choose the name.',
          'For ChatGPT or other clients without lifecycle hooks, start_agent_build after Agent selection and naming, then call upsert_agent_build_snapshot before each assistant reply that changes the draft.',
          'All synchronized content is an inert shadow draft. Never claim an Agent or Skill is active unless get_agent_build returns ACTIVE.',
          'Never bypass FDE review, Skill confirmation, real testing or final activation gates.',
          'For using an existing employee, call list_available_agents, then get_agent_capabilities, invoke_agent with a stable idempotency key, and poll get_agent_run.',
          'request_agent_schedule creates only a pending proposal; never claim the schedule is active until an FDE approves it and list_agent_schedules shows it enabled.',
        ].join(' '),
      },
    );
    if (config.profile === 'builder') {
      registerBuilderTools(server, client);
      registerBuilderResources(server, client);
    } else {
      registerAllTools(server, client);
      registerAllResources(server, client);
    }
    registerAllPrompts(server);
    return server;
  };

  if (config.transport === 'http' && config.httpAuth === 'oauth') {
    await runHttp(
      (accessToken) => {
        if (!accessToken) throw new Error('OAuth transport did not supply an access token');
        return buildServer(new HttpClient(config.baseUrl, new FixedAccessTokenProvider(accessToken)));
      },
      {
        port: config.httpPort,
        baseUrl: config.baseUrl,
        authMode: 'oauth',
        publicUrl: config.publicUrl,
      },
    );
    return;
  }

  localAuth = new AuthManager(config);
  // One-shot logout mode: revoke the persisted refresh token and exit.
  if (config.logout) {
    await localAuth.logout();
    console.error('aios-mcp: refresh token revoked and local session state cleared.');
    return;
  }

  await localAuth.start();
  const localClient = new HttpClient(config.baseUrl, localAuth);

  const shutdown = (): void => {
    // Deliberately NOT calling /api/auth/logout — the refresh token persists on disk so
    // the next start-up resumes without a fresh login (see AIOS_MCP_LOGOUT for revocation).
    localAuth?.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (config.transport === 'http') {
    await runHttp(() => buildServer(localClient), {
      port: config.httpPort,
      baseUrl: config.baseUrl,
      authMode: 'secret',
      secret: config.httpSecret,
    });
  } else {
    await runStdio(buildServer(localClient));
  }
}

main().catch((err) => {
  console.error('aios-mcp: fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
