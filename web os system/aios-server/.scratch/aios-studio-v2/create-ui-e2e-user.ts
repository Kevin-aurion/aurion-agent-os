import { ulid } from 'ulid';
import { prisma } from '../../src/lib/db.js';
import { hashPassword } from '../../src/lib/auth.js';

const email = 'studio-e2e-20260810@lazyoffice.test';
await prisma.user.upsert({
  where: { email },
  create: {
    id: ulid(),
    email,
    displayName: 'Studio E2E',
    passwordHash: await hashPassword('Studio-E2E-Temporary-0826!'),
    role: 'TRAINER',
  },
  update: {
    displayName: 'Studio E2E',
    passwordHash: await hashPassword('Studio-E2E-Temporary-0826!'),
    role: 'TRAINER',
    deletedAt: null,
  },
});
process.stdout.write('Temporary TRAINER test identity ready.\n');
await prisma.$disconnect();
