-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'TRAINER';

-- AlterTable
ALTER TABLE "CloudFileRef" ADD COLUMN     "webUrl" TEXT;
