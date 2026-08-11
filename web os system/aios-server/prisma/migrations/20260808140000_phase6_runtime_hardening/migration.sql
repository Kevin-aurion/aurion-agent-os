-- CreateEnum
CREATE TYPE "RuntimeDeadLetterStatus" AS ENUM ('PENDING', 'REPLAYED', 'DISCARDED');

-- CreateTable
CREATE TABLE "RuntimeDeadLetter" (
    "id" TEXT NOT NULL,
    "runId" TEXT,
    "workflowId" TEXT NOT NULL,
    "deploymentId" TEXT,
    "artifactId" TEXT,
    "code" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "RuntimeDeadLetterStatus" NOT NULL DEFAULT 'PENDING',
    "replayedRunId" TEXT,
    "replayedBy" TEXT,
    "replayedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RuntimeDeadLetter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RuntimeDeadLetter_status_createdAt_idx" ON "RuntimeDeadLetter"("status", "createdAt");
