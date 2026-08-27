// Provision the approved customer accounts as isolated MEMBER identities.
// Passwords are shown only in a mode-0600 handoff file outside the repository.
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { hashPassword } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { prisma } from '../lib/db.js';

const customerEmailDomain = process.env.AIOS_CUSTOMER_EMAIL_DOMAIN?.trim() || 'aurion-group.com';
const ownerEmail = process.env.AIOS_OWNER_EMAIL?.trim() || 'fde@aios.test';
const requestedNames = process.env.AIOS_CUSTOMER_NAMES
  ?.split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const accounts = (requestedNames?.length ? requestedNames : ['Vincent', 'Lauren', 'Kate']).map((displayName) => ({
  email: `${displayName.toLowerCase()}@${customerEmailDomain}`,
  displayName,
}));

const handoffPath = path.resolve(
  process.env.AIOS_ACCOUNT_HANDOFF_PATH?.trim()
    || path.join(homedir(), 'Documents', 'Aurion AIOS Private', '客戶帳號-2026-08-08.txt'),
);
const tempPath = `${handoffPath}.${process.pid}.tmp`;
const loginUrl = process.env.AIOS_PUBLIC_LOGIN_URL?.trim()
  || 'https://aurion-aios.lazyoffice.app/login';

async function main() {
  const owner = await prisma.user.findFirst({
    where: { email: ownerEmail, deletedAt: null, role: 'OWNER' },
    select: { id: true, email: true, role: true },
  });
  if (!owner) throw new Error('Kevin OWNER account not found; refusing to provision');

  const credentials: Array<{ email: string; password: string }> = [];

  for (const account of accounts) {
    // 12 random bytes encode to exactly 16 base64url characters (96 bits).
    // This is shorter for handoff while retaining substantially more entropy
    // than a 16-character hexadecimal password.
    const password = randomBytes(12).toString('base64url');
    const passwordHash = await hashPassword(password);
    const existing = await prisma.user.findUnique({ where: { email: account.email } });

    const user = await prisma.$transaction(async (tx) => {
      const saved = existing
        ? await tx.user.update({
            where: { id: existing.id },
            data: {
              displayName: account.displayName,
              passwordHash,
              role: 'MEMBER',
              deletedAt: null,
            },
          })
        : await tx.user.create({
            data: {
              id: ulid(),
              email: account.email,
              displayName: account.displayName,
              passwordHash,
              role: 'MEMBER',
            },
          });

      // A newly issued password invalidates every older web or plugin session.
      await tx.session.updateMany({
        where: { userId: saved.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.mcpOAuthCode.deleteMany({ where: { userId: saved.id } });
      return saved;
    });

    await audit(owner.id, 'user.customer_account_provisioned', 'User', user.id, {
      email: user.email,
      role: user.role,
      passwordRotated: existing != null,
    });
    credentials.push({ email: user.email, password });
  }

  const handoff = [
    'Aurion AIOS 客戶帳號（機密）',
    `建立時間：${new Date().toISOString()}`,
    `登入網址：${loginUrl}`,
    '',
    ...credentials.flatMap((item) => [
      `帳號：${item.email}`,
      `密碼：${item.password}`,
      '角色：MEMBER',
      '',
    ]),
    '說明：Claude／GPT Plugin 必須各自使用上面的 AIOS 帳號完成 OAuth 登入。',
    '每個帳號建立的對話、建置紀錄與正式 Agent 都會以該登入者身分隔離。',
    '',
  ].join('\n');

  await mkdir(path.dirname(handoffPath), { recursive: true, mode: 0o700 });
  await writeFile(tempPath, handoff, { encoding: 'utf8', mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, handoffPath);
  await chmod(handoffPath, 0o600);

  console.log(`Provisioned ${credentials.length} MEMBER accounts.`);
  console.log(`Credentials were written to ${handoffPath} with mode 0600.`);
  console.log('Passwords were not printed.');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    try {
      await prisma.$disconnect();
    } finally {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
