-- CreateEnum
CREATE TYPE "RunTraceOutcome" AS ENUM ('SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "A2ATaskStatus" AS ENUM ('PENDING', 'SUBMITTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "ProposalSource" ADD VALUE 'TRAJECTORY';

-- CreateTable
CREATE TABLE "RunTrace" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "selectedSkills" JSONB NOT NULL,
    "trajectory" JSONB NOT NULL,
    "verifierFeedback" JSONB NOT NULL,
    "outcome" "RunTraceOutcome" NOT NULL,
    "trajectoryKey" TEXT,
    "engineExecute" "Engine" NOT NULL,
    "engineVerify" "Engine" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunTrace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "A2APeer" (
    "id" TEXT NOT NULL,
    "peerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "baseUrl" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "credentialRef" TEXT,
    "riskTier" TEXT NOT NULL DEFAULT 'high',
    "maxPayloadBytes" INTEGER NOT NULL DEFAULT 65536,
    "timeoutMs" INTEGER NOT NULL DEFAULT 30000,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "A2APeer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "A2ATask" (
    "id" TEXT NOT NULL,
    "peerId" TEXT NOT NULL,
    "agentId" TEXT,
    "remoteTaskId" TEXT,
    "status" "A2ATaskStatus" NOT NULL DEFAULT 'PENDING',
    "requestSummary" JSONB,
    "responseSummary" JSONB,
    "submittedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "A2ATask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RunTrace_runId_key" ON "RunTrace"("runId");

-- CreateIndex
CREATE INDEX "RunTrace_agentId_createdAt_idx" ON "RunTrace"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "RunTrace_trajectoryKey_idx" ON "RunTrace"("trajectoryKey");

-- CreateIndex
CREATE UNIQUE INDEX "A2APeer_peerId_key" ON "A2APeer"("peerId");

-- CreateIndex
CREATE INDEX "A2APeer_enabled_idx" ON "A2APeer"("enabled");

-- CreateIndex
CREATE INDEX "A2ATask_peerId_createdAt_idx" ON "A2ATask"("peerId", "createdAt");

-- CreateIndex
CREATE INDEX "A2ATask_status_idx" ON "A2ATask"("status");

-- AddForeignKey
ALTER TABLE "A2ATask" ADD CONSTRAINT "A2ATask_peerId_fkey" FOREIGN KEY ("peerId") REFERENCES "A2APeer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
