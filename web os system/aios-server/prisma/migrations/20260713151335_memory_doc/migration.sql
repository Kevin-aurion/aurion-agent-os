-- CreateTable
CREATE TABLE "MemoryDoc" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryDoc_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MemoryDoc_agentId_idx" ON "MemoryDoc"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryDoc_agentId_path_key" ON "MemoryDoc"("agentId", "path");
