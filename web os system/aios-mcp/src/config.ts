// Reads and validates all AIOS_MCP_* env vars (zod), with defaults.
// Loads .env from the package root so the same file works from src/ (tsx) and dist/ (built).
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import dotenv from 'dotenv';
import { z } from 'zod';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: resolve(pkgRoot, '.env') });

const EnvSchema = z.object({
  AIOS_MCP_BASE_URL: z.string().url().default('http://127.0.0.1:8700'),
  AIOS_MCP_EMAIL: z.string().email({ message: 'AIOS_MCP_EMAIL must be a valid email' }).optional(),
  AIOS_MCP_PASSWORD: z.string().min(1, 'AIOS_MCP_PASSWORD is required').optional(),
  AIOS_MCP_CLIENT_NAME: z.string().min(1).default('mcp'),
  AIOS_MCP_PROFILE: z.enum(['full', 'builder']).default('full'),
  AIOS_MCP_STATE_DIR: z.string().min(1).default('~/.aios-mcp'),
  AIOS_MCP_TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
  AIOS_MCP_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8701),
  AIOS_MCP_HTTP_AUTH: z.enum(['secret', 'oauth']).default('secret'),
  AIOS_MCP_HTTP_SECRET: z.string().optional(),
  AIOS_MCP_PUBLIC_URL: z.string().url().optional(),
  AIOS_MCP_LOGOUT: z.string().optional(),
});

export interface Config {
  baseUrl: string;
  email: string | undefined;
  password: string | undefined;
  clientName: string;
  profile: 'full' | 'builder';
  stateDir: string;
  transport: 'stdio' | 'http';
  httpPort: number;
  httpAuth: 'secret' | 'oauth';
  httpSecret: string | undefined;
  publicUrl: string | undefined;
  logout: boolean;
}

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

export function loadConfig(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(env)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `aios-mcp: invalid environment configuration.\n${issues}\n` +
        'Set AIOS_MCP_EMAIL and AIOS_MCP_PASSWORD (see .env.example).',
    );
  }
  const env = parsed.data;
  const config: Config = {
    baseUrl: env.AIOS_MCP_BASE_URL.replace(/\/+$/, ''),
    email: env.AIOS_MCP_EMAIL,
    password: env.AIOS_MCP_PASSWORD,
    clientName: env.AIOS_MCP_CLIENT_NAME,
    profile: env.AIOS_MCP_PROFILE,
    stateDir: expandTilde(env.AIOS_MCP_STATE_DIR),
    transport: env.AIOS_MCP_TRANSPORT,
    httpPort: env.AIOS_MCP_HTTP_PORT,
    httpAuth: env.AIOS_MCP_HTTP_AUTH,
    httpSecret: env.AIOS_MCP_HTTP_SECRET,
    publicUrl: env.AIOS_MCP_PUBLIC_URL?.replace(/\/+$/, ''),
    logout: env.AIOS_MCP_LOGOUT === '1' || env.AIOS_MCP_LOGOUT === 'true',
  };
  if (config.transport === 'http' && config.httpAuth === 'secret' && !config.httpSecret) {
    throw new Error(
      'aios-mcp: AIOS_MCP_HTTP_SECRET is required when AIOS_MCP_TRANSPORT=http and AIOS_MCP_HTTP_AUTH=secret ' +
        '(every HTTP request must carry the x-aios-mcp-secret header).',
    );
  }
  if (config.transport === 'http' && config.httpAuth === 'oauth' && !config.publicUrl) {
    throw new Error('aios-mcp: AIOS_MCP_PUBLIC_URL is required for the OAuth Remote MCP transport.');
  }
  if ((config.transport === 'stdio' || config.httpAuth === 'secret') && (!config.email || !config.password)) {
    throw new Error('aios-mcp: AIOS_MCP_EMAIL and AIOS_MCP_PASSWORD are required for local/secret mode.');
  }
  return config;
}
