// Read/write the persisted refresh-token file (session.json, mode 0600) under AIOS_MCP_STATE_DIR.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface PersistedSession {
  refresh: string;
  userId: string;
  email: string;
}

function sessionPath(stateDir: string): string {
  return join(stateDir, 'session.json');
}

export async function loadState(stateDir: string): Promise<PersistedSession | null> {
  try {
    const raw = await readFile(sessionPath(stateDir), 'utf8');
    const data = JSON.parse(raw) as Partial<PersistedSession>;
    if (typeof data.refresh === 'string' && data.refresh.length > 0) {
      return {
        refresh: data.refresh,
        userId: typeof data.userId === 'string' ? data.userId : '',
        email: typeof data.email === 'string' ? data.email : '',
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveState(stateDir: string, session: PersistedSession): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(sessionPath(stateDir), JSON.stringify(session, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
}

export async function clearState(stateDir: string): Promise<void> {
  await rm(sessionPath(stateDir), { force: true });
}
