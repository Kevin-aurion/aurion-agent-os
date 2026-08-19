import { prisma } from '../../src/lib/db.js';

const email = 'studio-e2e-20260810@aurion.test';
const user = await prisma.user.findUnique({ where: { email } });
if (user) {
  await prisma.session.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });
}
process.stdout.write('Temporary Studio test identity removed.\n');
await prisma.$disconnect();
