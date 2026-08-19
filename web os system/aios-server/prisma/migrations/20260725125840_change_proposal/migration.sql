-- CreateEnum
CREATE TYPE "ProposalSource" AS ENUM ('OPERATOR', 'VIOLATION', 'SEMANTIC');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ProposalTarget" AS ENUM ('SKILL', 'RESTRICTION', 'IDENTITY_CARD');

-- CreateTable
CREATE TABLE "ChangeProposal" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "runId" TEXT,
    "source" "ProposalSource" NOT NULL,
    "proposedBy" TEXT NOT NULL,
    "targetType" "ProposalTarget" NOT NULL,
    "targetId" TEXT,
    "proposedChange" JSONB NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "confidence" DOUBLE PRECISION,
    "status" "ProposalStatus" NOT NULL DEFAULT 'PENDING',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "resultingVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChangeProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChangeProposal_status_createdAt_idx" ON "ChangeProposal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ChangeProposal_agentId_createdAt_idx" ON "ChangeProposal"("agentId", "createdAt");
