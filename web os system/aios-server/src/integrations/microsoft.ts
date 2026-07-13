// Microsoft identity platform (Entra ID) OAuth2 for Graph access.
// Uses ConfidentialClientApplication when MS_CLIENT_SECRET is set, otherwise
// falls back to a PublicClientApplication + PKCE (no secret needed).
import {
  ConfidentialClientApplication,
  PublicClientApplication,
  CryptoProvider,
  type AuthenticationResult,
} from '@azure/msal-node';
import { config } from '../config.js';

type MsalApp = PublicClientApplication | ConfidentialClientApplication;

const hasSecret = !!config.microsoft.clientSecret;
const authority = `https://login.microsoftonline.com/${config.microsoft.tenantId}`;

let app: MsalApp | undefined;

function getApp(): MsalApp {
  if (app) return app;
  app = hasSecret
    ? new ConfidentialClientApplication({
        auth: { clientId: config.microsoft.clientId, authority, clientSecret: config.microsoft.clientSecret },
      })
    : new PublicClientApplication({
        auth: { clientId: config.microsoft.clientId, authority },
      });
  return app;
}

/** Pulls the raw refresh token secret out of MSAL's in-memory token cache. */
function extractRefreshToken(a: MsalApp, homeAccountId?: string | null): string | undefined {
  const serialized = a.getTokenCache().serialize();
  const parsed = JSON.parse(serialized) as { RefreshToken?: Record<string, { secret?: string; home_account_id?: string }> };
  const entries = Object.values(parsed.RefreshToken ?? {});
  if (entries.length === 0) return undefined;
  const match = homeAccountId ? entries.find((e) => e.home_account_id === homeAccountId) : undefined;
  return (match ?? entries[entries.length - 1])?.secret;
}

export interface MsTokenResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  accountId: string;
  email: string;
  scopes: string[];
}

/** Builds the /authorize URL. PKCE is used automatically for public clients, and
 * can be forced on for confidential clients too via opts.pkce. */
export async function getAuthUrl(opts: { state: string; pkce?: boolean }): Promise<{ url: string; pkceVerifier?: string }> {
  const wantPkce = opts.pkce ?? !hasSecret;
  let codeVerifier: string | undefined;
  let codeChallenge: string | undefined;
  if (wantPkce) {
    const codes = await new CryptoProvider().generatePkceCodes();
    codeVerifier = codes.verifier;
    codeChallenge = codes.challenge;
  }
  const url = await getApp().getAuthCodeUrl({
    scopes: [...config.microsoft.scopes],
    redirectUri: config.microsoft.redirectUri,
    state: opts.state,
    ...(codeChallenge ? { codeChallenge, codeChallengeMethod: 'S256' as const } : {}),
  });
  return { url, pkceVerifier: codeVerifier };
}

export async function exchangeCode(opts: { code: string; pkceVerifier?: string }): Promise<MsTokenResult> {
  const a = getApp();
  const result: AuthenticationResult | null = await a.acquireTokenByCode({
    scopes: [...config.microsoft.scopes],
    redirectUri: config.microsoft.redirectUri,
    code: opts.code,
    codeVerifier: opts.pkceVerifier,
  });
  if (!result) throw new Error('Microsoft OAuth: token exchange returned no result');
  const refreshToken = extractRefreshToken(a, result.account?.homeAccountId);
  if (!refreshToken) throw new Error('Microsoft OAuth: no refresh token found (ensure offline_access scope is granted)');
  return {
    accessToken: result.accessToken,
    refreshToken,
    expiresAt: result.expiresOn ?? new Date(Date.now() + 3600_000),
    accountId: result.account?.homeAccountId ?? result.uniqueId,
    email: result.account?.username ?? '',
    scopes: result.scopes,
  };
}

export interface MsRefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
}

export async function refresh(refreshToken: string): Promise<MsRefreshResult> {
  const a = getApp();
  const result = await a.acquireTokenByRefreshToken({ scopes: [...config.microsoft.scopes], refreshToken });
  if (!result) throw new Error('Microsoft OAuth: refresh returned no result');
  const rotated = extractRefreshToken(a, result.account?.homeAccountId) ?? refreshToken;
  return {
    accessToken: result.accessToken,
    refreshToken: rotated,
    expiresAt: result.expiresOn ?? new Date(Date.now() + 3600_000),
    scopes: result.scopes,
  };
}

/** Thin fetch wrapper against Microsoft Graph v1.0. */
export async function graphFetch(accessToken: string, path: string, init?: RequestInit): Promise<any> {
  const url = path.startsWith('http') ? path : `https://graph.microsoft.com/v1.0${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (init?.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Graph ${init?.method ?? 'GET'} ${path} failed: ${res.status} ${text}`);
  }
  if (res.status === 204) return null;
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) return res.json();
  return Buffer.from(await res.arrayBuffer());
}
