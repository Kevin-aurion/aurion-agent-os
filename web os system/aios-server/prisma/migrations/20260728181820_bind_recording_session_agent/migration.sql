-- AlterTable
ALTER TABLE "RecordingSession" ADD COLUMN     "agentId" TEXT;

-- CreateIndex
CREATE INDEX "RecordingSession_agentId_idx" ON "RecordingSession"("agentId");
