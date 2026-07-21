-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "costPolicy" JSONB,
ADD COLUMN     "riskTier" TEXT NOT NULL DEFAULT 'medium';

-- CreateTable
CREATE TABLE "CostLog" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "runId" TEXT,
    "engine" "Engine" NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "costUsd" DECIMAL(12,6) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CostLog_agentId_createdAt_idx" ON "CostLog"("agentId", "createdAt");
