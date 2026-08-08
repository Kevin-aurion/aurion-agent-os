-- CreateEnum
CREATE TYPE "AgentBuildSessionStatus" AS ENUM ('DISCOVERY', 'PLAN_READY', 'AWAITING_FDE', 'BUILDING', 'AWAITING_TEST_DATA', 'TESTING', 'PASSED', 'FAILED', 'ACTIVE');

-- CreateTable
CREATE TABLE "AgentBuildSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "AgentBuildSessionStatus" NOT NULL DEFAULT 'DISCOVERY',
    "transcript" JSONB NOT NULL DEFAULT '[]',
    "brief" JSONB,
    "plan" JSONB,
    "progress" JSONB,
    "strategy" TEXT,
    "targetAgentId" TEXT,
    "builtAgentId" TEXT,
    "draftSkillIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "testData" JSONB,
    "testExpected" JSONB,
    "testResult" JSONB,
    "lastRunId" TEXT,
    "lastAssistantMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentBuildSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentBuildSession_userId_createdAt_idx" ON "AgentBuildSession"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentBuildSession_status_createdAt_idx" ON "AgentBuildSession"("status", "createdAt");
