// Google OAuth2 (google-auth-library) + Drive/Gmail client builders.
import { OAuth2Client } from 'google-auth-library';
import { drive, drive_v3 } from '@googleapis/drive';
import { gmail, gmail_v1 } from '@googleapis/gmail';
import { config } from '../config.js';

function buildOAuthClient(): OAuth2Client {
  return new OAuth2Client(config.google.clientId, config.google.clientSecret, config.google.redirectUri);
}

export function getAuthUrl(opts: { state: string }): string {
  const client = buildOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [...config.google.scopes],
    state: opts.state,
  });
}

export interface GoogleTokenResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  accountId: string;
  email: string;
  scopes: string[];
}

async function decodeIdentity(client: OAuth2Client, idToken?: string | null): Promise<{ sub: string; email: string }> {
  if (!idToken) return { sub: '', email: '' };
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: config.google.clientId });
    const payload = ticket.getPayload();
    return { sub: payload?.sub ?? '', email: payload?.email ?? '' };
  } catch {
    return { sub: '', email: '' };
  }
}

export async function exchangeCode(code: string): Promise<GoogleTokenResult> {
  const client = buildOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.access_token) throw new Error('Google OAuth: token exchange returned no access_token');
  if (!tokens.refresh_token) {
    throw new Error('Google OAuth: no refresh_token returned (re-consent with access_type=offline&prompt=consent)');
  }
  const { sub, email } = await decodeIdentity(client, tokens.id_token);
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : new Date(Date.now() + 3600_000),
    accountId: sub || email,
    email,
    scopes: (tokens.scope ?? config.google.scopes.join(' ')).split(' ').filter(Boolean),
  };
}

export interface GoogleRefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
}

export async function refresh(refreshToken: string): Promise<GoogleRefreshResult> {
  const client = buildOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await client.refreshAccessToken();
  if (!credentials.access_token) throw new Error('Google OAuth: refresh returned no access_token');
  return {
    accessToken: credentials.access_token,
    refreshToken: credentials.refresh_token ?? refreshToken,
    expiresAt: credentials.expiry_date ? new Date(credentials.expiry_date) : new Date(Date.now() + 3600_000),
    scopes: (credentials.scope ?? '').split(' ').filter(Boolean),
  };
}

/** Builds an authenticated Drive v3 client from a live access token. */
export function driveClientFor(accessToken: string): drive_v3.Drive {
  const auth = buildOAuthClient();
  auth.setCredentials({ access_token: accessToken });
  return drive({ version: 'v3', auth });
}

/** Builds an authenticated Gmail v1 client from a live access token. */
export function gmailClientFor(accessToken: string): gmail_v1.Gmail {
  const auth = buildOAuthClient();
  auth.setCredentials({ access_token: accessToken });
  return gmail({ version: 'v1', auth });
}
