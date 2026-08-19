import { ulid } from 'ulid';
import { prisma } from '../../src/lib/db.js';
import { hashPassword } from '../../src/lib/auth.js';

const email = process.env.AIOS_E2E_EMAIL;
const password = process.env.AIOS_E2E_PASSWORD;
const action = process.argv[2];

if (!email) throw new Error('AIOS_E2E_EMAIL is required');

if (action === 'create') {
  if (!password) throw new Error('AIOS_E2E_PASSWORD is required');
  await prisma.user.upsert({
    where: { email },
    create: {
      id: ulid(),
      email,
      displayName: 'Conversational Training E2E',
      passwordHash: await hashPassword(password),
      role: 'OWNER',
    },
    update: {
      displayName: 'Conversational Training E2E',
      passwordHash: await hashPassword(password),
      role: 'OWNER',
      deletedAt: null,
    },
  });
  console.log('created');
} else if (action === 'delete') {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (user) {
    await prisma.session.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  console.log('deleted');
} else {
  throw new Error('action must be create or delete');
}

await prisma.$disconnect();
