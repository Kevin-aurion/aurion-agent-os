import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
  log: process.env.AIOS_DEBUG ? ['query', 'warn', 'error'] : ['warn', 'error'],
});

export async function disconnectDb() {
  await prisma.$disconnect();
}
