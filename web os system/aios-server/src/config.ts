import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Missing required env var: ${name} (fill it in web os system/.env)`);
  }
  return v;
}

function opt(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

/** Default Codex App home (~/.codex). Overridable via CODEX_HOME. */
const codexHomeDefault = path.join(os.homedir(), '.codex');
const codexHome = opt('CODEX_HOME', codexHomeDefault) || codexHomeDefault;

export const config = {
  httpPort: Number(opt('AIOS_HTTP_PORT', '8700')),
  webPort: Number(opt('AIOS_WEB_PORT', '3100')),
  webOrigin: opt('AIOS_WEB_ORIGIN', 'http://localhost:3100'),
  publicOrigin: opt('AIOS_PUBLIC_ORIGIN', 'https://aurion-aios.lazyoffice.app').replace(/\/+$/, ''),
  databaseUrl: req('DATABASE_URL'),
  redisUrl: req('REDIS_URL'),
  dataDir: opt('AIOS_DATA_DIR', path.resolve(process.cwd(), '../../aios-data')),
  // Human-browsable agent workspace at the aurion top level (sibling of the
  // "mac os system" / "web os system" folders). Agents are materialized under
  // MyAgent/<department>/<slug>/.
  myAgentDir: opt('AIOS_MYAGENT_DIR', path.resolve(process.cwd(), '..', '..', 'MyAgent')),
  tz: opt('AIOS_TZ', 'Asia/Taipei'),

  encryptionKey: req('AIOS_ENCRYPTION_KEY'),
  jwtSecret: req('AIOS_JWT_SECRET'),

  microsoft: {
    clientId: opt('MS_CLIENT_ID'),
    tenantId: opt('MS_TENANT_ID', 'common'),
    clientSecret: opt('MS_CLIENT_SECRET'),
    redirectUri: opt('MS_REDIRECT_URI', 'http://localhost:8700/api/integrations/microsoft/callback'),
    scopes: ['offline_access', 'User.Read', 'Files.ReadWrite.All', 'Mail.Read', 'Mail.Send'],
  },
  google: {
    clientId: opt('GOOGLE_CLIENT_ID'),
    clientSecret: opt('GOOGLE_CLIENT_SECRET'),
    redirectUri: opt('GOOGLE_REDIRECT_URI', 'http://localhost:8700/api/integrations/google/callback'),
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
    ],
  },
  line: {
    accessToken: opt('LINE_CHANNEL_ACCESS_TOKEN'),
    channelSecret: opt('LINE_CHANNEL_SECRET'),
    webhookSecret: opt('LINE_WEBHOOK_SECRET'),
    tunnel: opt('LINE_WEBHOOK_TUNNEL'),
  },
  engines: {
    claudePath: opt('CLAUDE_CLI_PATH', 'claude'),
    codexPath: opt('CODEX_CLI_PATH', 'codex'),
    grokPath: opt('GROK_CLI_PATH', 'grok'),
  },

  // Codex App MCP bridges (Computer Use + Record & Replay). Paths verified on
  // macOS Codex install; override with env when App layout drifts.
  codex: {
    home: codexHome,
    computerUseDir: opt('CODEX_COMPUTER_USE_DIR', path.join(codexHome, 'computer-use')),
    computerUseBin: opt(
      'CODEX_COMPUTER_USE_BIN',
      path.join(
        codexHome,
        'computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient',
      ),
    ),
    recordPluginDir: opt(
      'CODEX_RECORD_PLUGIN_DIR',
      path.join(codexHome, '.tmp/bundled-marketplaces/openai-bundled/plugins/record-and-replay'),
    ),
    recordLauncher: opt(
      'CODEX_RECORD_LAUNCHER',
      path.join(
        codexHome,
        '.tmp/bundled-marketplaces/openai-bundled/plugins/record-and-replay/bin/computer-use-client-launcher',
      ),
    ),
  },

  // Local Docling document-parse service (docker aios-docparse, loopback only).
  docparse: {
    url: opt('DOCPARSE_URL', 'http://127.0.0.1:5001'),
  },

  // Read-only AI knowledge pilot. The vault remains the source of truth;
  // Langflow receives only an already-grounded, redacted answer envelope.
  knowledgePilot: {
    vaultDir: opt(
      'AIOS_KNOWLEDGE_VAULT_ROOT',
      path.resolve(process.cwd(), '..', '..', '..', 'AI知識庫'),
    ),
    pythonPath: opt('AIOS_KNOWLEDGE_PYTHON_PATH', '/usr/bin/python3'),
    flowId: opt(
      'AIOS_KNOWLEDGE_LANGFLOW_ID',
      '4ec97062-f088-45b6-a304-a4fe1d1c9f26',
    ),
  },

  // OpenAI (Whisper voice transcription for skill-training UI). Optional —
  // missing key or VOICE_ENABLED=false returns a clear NOT_CONFIGURED error.
  openaiApiKey: opt('OPENAI_API_KEY'),
  voice: {
    enabled: opt('VOICE_ENABLED', 'true').toLowerCase() !== 'false',
    model: opt('WHISPER_MODEL', 'whisper-1') || 'whisper-1',
  },

  remoteMcp: {
    issuer: opt('AIOS_MCP_OAUTH_ISSUER', 'https://aios-mcp.lazyoffice.app').replace(/\/+$/, ''),
    resourceUrl: opt(
      'AIOS_MCP_PUBLIC_URL',
      'https://aios-mcp.lazyoffice.app/mcp',
    ).replace(/\/+$/, ''),
  },

  // Memory (Phase 1): L1 wiki on disk is source of truth; L3 Qdrant is a
  // rebuildable semantic index. When enabled=false every memory I/O is no-op.
  memory: {
    enabled: opt('MEMORY_ENABLED', 'true').toLowerCase() !== 'false',
    qdrantUrl: opt('QDRANT_URL', 'http://127.0.0.1:6333'),
    collection: 'aios_memory',
    // openrouter | google — adapter interface keeps call sites provider-agnostic.
    embeddingProvider: opt('EMBEDDING_PROVIDER', 'openrouter'),
    openrouterBaseUrl: opt('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
    openrouterApiKey: opt('OPENROUTER_API_KEY'),
    // Confirmed OpenRouter model id (openrouter.ai/google/gemini-embedding-001).
    // Default vector size 3072 (Google gemini-embedding-001 default; also supports 768/1536).
    embeddingModel: opt('EMBEDDING_MODEL', 'google/gemini-embedding-001'),
    embeddingDimension: Number(opt('EMBEDDING_DIMENSION', '3072')),
    // Fallback when EMBEDDING_PROVIDER=google (direct Google Gemini embeddings API).
    geminiApiKey: opt('GEMINI_API_KEY'),
  },
} as const;

export const paths = {
  agents: config.myAgentDir,
  skills: path.join(config.dataDir, 'skills'),
  cache: path.join(config.dataDir, 'cache'),
  computerControl: path.join(config.dataDir, 'computer-control'),
  runs: path.join(config.dataDir, 'runs'),
  // Durable DeviceArtifact binaries (screenshots etc.); never via WebSocket.
  deviceArtifacts: path.join(config.dataDir, 'device-artifacts'),
  knowledgePilotRuns: path.join(config.dataDir, 'runs', 'knowledge-pilot'),
  builtinSkills: path.resolve(process.cwd(), 'builtin-skills'),
};

/** Which integrations are configured (keys present in .env). */
export const integrationsReady = {
  microsoft: () => !!config.microsoft.clientId,
  google: () => !!config.google.clientId,
  line: () => !!config.line.accessToken && !!config.line.channelSecret,
};
