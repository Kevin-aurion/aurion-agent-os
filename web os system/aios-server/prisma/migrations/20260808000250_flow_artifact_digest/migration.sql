-- CreateEnum
CREATE TYPE "RuntimeKind" AS ENUM ('NATIVE', 'LANGFLOW');

-- CreateEnum
CREATE TYPE "FlowArtifactStatus" AS ENUM ('COMPILED', 'VALIDATED', 'REJECTED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "FlowArtifact" (
    "id" TEXT NOT NULL,
    "skillVersionId" TEXT,
    "workflowId" TEXT,
    "runtimeKind" "RuntimeKind" NOT NULL,
    "template" TEXT NOT NULL,
    "templateVersion" TEXT,
    "compilerVersion" TEXT NOT NULL,
    "artifactJson" JSONB NOT NULL,
    "digest" TEXT NOT NULL,
    "status" "FlowArtifactStatus" NOT NULL DEFAULT 'COMPILED',
    "metadata" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FlowArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FlowArtifact_skillVersionId_idx" ON "FlowArtifact"("skillVersionId");

-- CreateIndex
CREATE INDEX "FlowArtifact_digest_idx" ON "FlowArtifact"("digest");

-- CreateIndex
CREATE INDEX "FlowArtifact_status_createdAt_idx" ON "FlowArtifact"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "FlowArtifact" ADD CONSTRAINT "FlowArtifact_skillVersionId_fkey" FOREIGN KEY ("skillVersionId") REFERENCES "SkillVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
