// Local-first OAuth token store: ConnectedAccount rows hold AES-256-GCM
// encrypted access/refresh tokens; this module is the only place that
// decrypts/refreshes/re-encrypts them.
import type { ConnectedAccount, Provider } from '@prisma/client';
import { ulid } from 'ulid';
import { prisma } from '../lib/db.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { errors } from '../lib/http.js';
import { hub } from '../ws/hub.js';
import * as microsoft from './microsoft.js';
import * as google from './google.js';

const REFRESH_MARGIN_MS = 120_000; // refresh if within 120s of expiry

function publishStatus(account: Pick<ConnectedAccount, 'id' | 'provider' | 'userId'>, status: string, extra?: Record<string, unknown>) {
  hub.publish('integration.status', { accountId: account.id, provider: account.provider, userId: account.userId, status, ...extra });
}

/**
 * Returns a live access token for the given ConnectedAccount, refreshing it
 * against the provider's token endpoint when it's within REFRESH_MARGIN_MS of
 * expiry (or already expired). Marks the account EXPIRED and publishes
 * integration.status on refresh failure.
 */
export async function getValidAccessToken(accountId: string): Promise<string> {
  const account = await prisma.connectedAccount.findUnique({ where: { id: accountId } });
  if (!account) throw errors.notFound(`ConnectedAccount ${accountId} not found`);
  if (account.status === 'DISCONNECTED') throw errors.notConfigured('Account is disconnected; reconnect required');

  const msUntilExpiry = account.accessTokenExpires.getTime() - Date.now();
  if (msUntilExpiry > REFRESH_MARGIN_MS) {
    return decrypt(account.accessTokenEnc);
  }

  const refreshToken = decrypt(account.refreshTokenEnc);
  try {
    const refreshed =
      account.provider === 'MICROSOFT' ? await microsoft.refresh(refreshToken) : await google.refresh(refreshToken);

    const updated = await prisma.connectedAccount.update({
      where: { id: accountId },
      data: {
        accessTokenEnc: encrypt(refreshed.accessToken),
        refreshTokenEnc: encrypt(refreshed.refreshToken || refreshToken),
        accessTokenExpires: refreshed.expiresAt,
        status: 'CONNECTED',
      },
    });
    publishStatus(updated, 'CONNECTED');
    return refreshed.accessToken;
  } catch (e) {
    const updated = await prisma.connectedAccount.update({
      where: { id: accountId },
      data: { status: 'EXPIRED' },
    });
    publishStatus(updated, 'EXPIRED', { error: e instanceof Error ? e.message : String(e) });
    throw errors.notConfigured(`Failed to refresh ${account.provider} token; reconnect required`);
  }
}

export interface SaveAccountInput {
  userId: string;
  provider: Provider;
  providerAccountId: string;
  email: string;
  scopes: string[];
  accessToken: string;
  refreshToken: string;
  accessTokenExpires: Date;
  meta?: Record<string, unknown>;
}

/** Upserts a ConnectedAccount, encrypting both tokens at rest. */
export async function saveAccount(input: SaveAccountInput): Promise<ConnectedAccount> {
  const shared = {
    email: input.email,
    scopes: input.scopes,
    accessTokenEnc: encrypt(input.accessToken),
    refreshTokenEnc: encrypt(input.refreshToken),
    accessTokenExpires: input.accessTokenExpires,
    status: 'CONNECTED' as const,
    meta: input.meta as object | undefined,
  };

  const account = await prisma.connectedAccount.upsert({
    where: {
      userId_provider_providerAccountId: {
        userId: input.userId,
        provider: input.provider,
        providerAccountId: input.providerAccountId,
      },
    },
    create: {
      id: ulid(),
      userId: input.userId,
      provider: input.provider,
      providerAccountId: input.providerAccountId,
      ...shared,
    },
    update: shared,
  });

  publishStatus(account, account.status);
  return account;
}
