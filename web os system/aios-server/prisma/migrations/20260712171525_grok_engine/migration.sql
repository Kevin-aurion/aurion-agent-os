-- AlterEnum
ALTER TYPE "Engine" ADD VALUE 'GROK';

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "engineVerify" "Engine";
