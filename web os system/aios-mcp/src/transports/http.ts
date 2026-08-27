// Streamable-HTTP transport. The process still binds only to loopback; Cloudflare
// publishes it. OAuth mode forwards each caller's short-lived AIOS bearer token,
// so users remain isolated and no customer machine runs an AIOS service.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

function secretMatches(provided: string | string[] | undefined, expected: string): boolean {
  const value = Array.isArray(provided) ? provided[0] : provided;
  if (!value) return false;
  // Hash both sides so timingSafeEqual gets equal-length buffers regardless of input length.
  const a = createHash('sha256').update(value).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function deny(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: status === 401 ? -32001 : -32000, message },
      id: null,
    }),
  );
}

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

async function bearerIsValid(baseUrl: string, token: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export interface HttpTransportOptions {
  port: number;
  baseUrl: string;
  authMode: 'secret' | 'oauth';
  secret?: string;
  publicUrl?: string;
}

export async function runHttp(
  buildServer: (accessToken?: string) => McpServer,
  options: HttpTransportOptions,
): Promise<void> {
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (pathname === '/healthz' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, transport: 'streamable-http', auth: options.authMode }));
        return;
      }
      if (pathname !== '/mcp') {
        deny(res, 404, 'Not found');
        return;
      }

      let accessToken: string | undefined;
      if (options.authMode === 'oauth') {
        const token = bearerToken(req.headers.authorization);
        const metadata = options.publicUrl
          ? new URL('/.well-known/oauth-protected-resource/mcp', options.publicUrl).toString()
          : '';
        const challenge = metadata
          ? `Bearer resource_metadata="${metadata}", scope="aios:agent-builder"`
          : 'Bearer scope="aios:agent-builder"';
        if (!token || !(await bearerIsValid(options.baseUrl, token))) {
          deny(res, 401, 'Unauthorized: valid OAuth bearer required', { 'www-authenticate': challenge });
          return;
        }
        accessToken = token;
      } else if (!options.secret || !secretMatches(req.headers['x-aios-mcp-secret'], options.secret)) {
        deny(res, 401, 'Unauthorized: missing or invalid x-aios-mcp-secret header');
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Method not allowed (stateless mode: POST only)' },
            id: null,
          }),
        );
        return;
      }
      // Stateless: fresh server + transport per request; torn down when the response closes.
      const server = buildServer(accessToken);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error('aios-mcp: http request error:', err);
      if (!res.headersSent) deny(res, 500, 'Internal server error');
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port, '127.0.0.1', () => resolve());
  });
  console.error(
    `aios-mcp: streamable-HTTP transport listening on http://127.0.0.1:${options.port}/mcp (${options.authMode})`,
  );
}
