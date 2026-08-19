-- CreateEnum
CREATE TYPE "AgentBuildIterationStatus" AS ENUM ('QUEUED', 'ANALYZING', 'BUILDING', 'READY', 'FAILED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "AgentBuildIteration" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "basedOnIterationId" TEXT,
    "triggerKind" TEXT NOT NULL DEFAULT 'message',
    "triggerSummary" TEXT NOT NULL,
    "status" "AgentBuildIterationStatus" NOT NULL DEFAULT 'QUEUED',
    "understanding" JSONB,
    "proposedChanges" JSONB,
    "artifactSnapshot" JSONB,
    "userSummary" TEXT,
    "fdeSummary" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentBuildIteration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentBuildIteration_sessionId_createdAt_idx" ON "AgentBuildIteration"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentBuildIteration_status_createdAt_idx" ON "AgentBuildIteration"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentBuildIteration_sessionId_sequence_key" ON "AgentBuildIteration"("sessionId", "sequence");

-- AddForeignKey
ALTER TABLE "AgentBuildIteration" ADD CONSTRAINT "AgentBuildIteration_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentBuildSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
