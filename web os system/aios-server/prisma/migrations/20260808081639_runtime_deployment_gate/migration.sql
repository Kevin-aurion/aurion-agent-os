-- CreateEnum
CREATE TYPE "DeploymentEnvironment" AS ENUM ('SANDBOX', 'STAGING', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "DeploymentChannel" AS ENUM ('CANARY', 'STABLE');

-- CreateTable
CREATE TABLE "RuntimeDeployment" (
    "id" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "environment" "DeploymentEnvironment" NOT NULL,
    "channel" "DeploymentChannel" NOT NULL,
    "runtimeBinding" JSONB NOT NULL,
    "deployedBy" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RuntimeDeployment_pkey" PRIMARY KEY ("id")
);

-- AlterTable Run: additive nullable columns only
ALTER TABLE "Run" ADD COLUMN "runtimeKind" "RuntimeKind",
ADD COLUMN "artifactId" TEXT,
ADD COLUMN "idempotencyKey" TEXT,
ADD COLUMN "executionModelFamily" TEXT,
ADD COLUMN "verificationModelFamily" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "RuntimeDeployment_artifactId_environment_channel_key" ON "RuntimeDeployment"("artifactId", "environment", "channel");

-- CreateIndex
CREATE INDEX "RuntimeDeployment_skillId_environment_channel_active_idx" ON "RuntimeDeployment"("skillId", "environment", "channel", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Run_idempotencyKey_key" ON "Run"("idempotencyKey");

-- AddForeignKey
ALTER TABLE "RuntimeDeployment" ADD CONSTRAINT "RuntimeDeployment_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "FlowArtifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
