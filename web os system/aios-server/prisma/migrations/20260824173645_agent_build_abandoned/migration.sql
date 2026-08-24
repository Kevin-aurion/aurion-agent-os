-- AlterEnum
ALTER TYPE "AgentBuildSessionStatus" ADD VALUE 'ABANDONED';

-- AlterTable
ALTER TABLE "AgentBuildSession" ADD COLUMN     "abandonedAt" TIMESTAMP(3);
