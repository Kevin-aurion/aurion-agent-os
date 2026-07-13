-- CreateEnum
CREATE TYPE "ExecutionEnv" AS ENUM ('CLI', 'DESKTOP_APP', 'DIRECT');

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "department" TEXT NOT NULL DEFAULT '未分類';

-- AlterTable
ALTER TABLE "Skill" ADD COLUMN     "executionEnv" "ExecutionEnv" NOT NULL DEFAULT 'CLI';
