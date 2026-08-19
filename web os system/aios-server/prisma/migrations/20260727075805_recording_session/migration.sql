-- CreateEnum
CREATE TYPE "RecordingSessionStatus" AS ENUM ('RECORDING', 'STOPPED', 'COMPILING', 'RECORDED', 'INTERRUPTED', 'FAILED');

-- CreateTable
CREATE TABLE "RecordingSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "RecordingSessionStatus" NOT NULL DEFAULT 'RECORDING',
    "artifactId" TEXT,
    "metadataPath" TEXT,
    "eventsPath" TEXT,
    "skillId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "stoppedAt" TIMESTAMP(3),
    "compiledAt" TIMESTAMP(3),

    CONSTRAINT "RecordingSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecordingSession_userId_idx" ON "RecordingSession"("userId");

-- CreateIndex
CREATE INDEX "RecordingSession_status_idx" ON "RecordingSession"("status");
