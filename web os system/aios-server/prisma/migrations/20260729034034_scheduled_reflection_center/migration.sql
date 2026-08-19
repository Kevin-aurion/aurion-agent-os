-- CreateEnum
CREATE TYPE "ReflectionCycleStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "FeedbackSentiment" AS ENUM ('POSITIVE', 'NEGATIVE', 'NEUTRAL', 'MIXED');

-- CreateEnum
CREATE TYPE "ReflectionSuggestionStatus" AS ENUM ('PENDING', 'PROPOSED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ReflectionSuggestionTarget" AS ENUM ('AGENT', 'SKILL');

-- AlterEnum
ALTER TYPE "ProposalSource" ADD VALUE 'REFLECTION';

-- AlterEnum
ALTER TYPE "ProposalTarget" ADD VALUE 'AGENT';

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "systemManaged" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ReflectionCycle" (
    "id" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "status" "ReflectionCycleStatus" NOT NULL DEFAULT 'RUNNING',
    "triggeredBy" TEXT NOT NULL,
    "sourceMessageCount" INTEGER NOT NULL DEFAULT 0,
    "analyzedFeedbackCount" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB,
    "runIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ReflectionCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReflectionFeedback" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "sentiment" "FeedbackSentiment" NOT NULL DEFAULT 'NEUTRAL',
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excerpt" TEXT NOT NULL,
    "reason" TEXT,
    "messageAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReflectionFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReflectionSuggestion" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "targetType" "ReflectionSuggestionTarget" NOT NULL,
    "agentId" TEXT NOT NULL,
    "skillId" TEXT,
    "title" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "proposedGuidance" TEXT NOT NULL,
    "evidenceMessageIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confidence" DOUBLE PRECISION,
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "status" "ReflectionSuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "changeProposalId" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReflectionSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReflectionCycle_status_windowEnd_idx" ON "ReflectionCycle"("status", "windowEnd");

-- CreateIndex
CREATE UNIQUE INDEX "ReflectionCycle_windowStart_windowEnd_key" ON "ReflectionCycle"("windowStart", "windowEnd");

-- CreateIndex
CREATE INDEX "ReflectionFeedback_agentId_messageAt_idx" ON "ReflectionFeedback"("agentId", "messageAt");

-- CreateIndex
CREATE INDEX "ReflectionFeedback_sentiment_messageAt_idx" ON "ReflectionFeedback"("sentiment", "messageAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReflectionFeedback_cycleId_messageId_key" ON "ReflectionFeedback"("cycleId", "messageId");

-- CreateIndex
CREATE INDEX "ReflectionSuggestion_status_createdAt_idx" ON "ReflectionSuggestion"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ReflectionSuggestion_agentId_createdAt_idx" ON "ReflectionSuggestion"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "ReflectionSuggestion_skillId_createdAt_idx" ON "ReflectionSuggestion"("skillId", "createdAt");

-- AddForeignKey
ALTER TABLE "ReflectionFeedback" ADD CONSTRAINT "ReflectionFeedback_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "ReflectionCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReflectionSuggestion" ADD CONSTRAINT "ReflectionSuggestion_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "ReflectionCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
