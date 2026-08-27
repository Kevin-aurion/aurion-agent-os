-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('MACOS', 'WINDOWS', 'LINUX');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('PENDING_ENROLLMENT', 'ACTIVE', 'REVOKED', 'DISABLED');

-- CreateEnum
CREATE TYPE "DeviceTaskKind" AS ENUM ('COMPUTER_CONTROL', 'MCP_TOOL', 'SCREENSHOT', 'CAPABILITY_PROBE', 'LINE_DESKTOP');

-- CreateEnum
CREATE TYPE "DeviceTaskStatus" AS ENUM ('PENDING', 'DISPATCHED', 'ACKED', 'RUNNING', 'AWAITING_CONFIRM', 'SUCCEEDED', 'FAILED', 'TIMEOUT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeviceArtifactKind" AS ENUM ('SCREENSHOT', 'LOG', 'BINARY', 'OTHER');

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" "DevicePlatform" NOT NULL,
    "status" "DeviceStatus" NOT NULL DEFAULT 'PENDING_ENROLLMENT',
    "tokenHash" TEXT,
    "tokenPrefix" TEXT,
    "capabilities" JSONB,
    "lastSeenAt" TIMESTAMP(3),
    "osVersion" TEXT,
    "appVersion" TEXT,
    "enrolledAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceEnrollment" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codePrefix" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentDevice" (
    "agentId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "boundBy" TEXT,
    "boundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentDevice_pkey" PRIMARY KEY ("agentId","deviceId")
);

-- CreateTable
CREATE TABLE "DeviceTask" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "agentId" TEXT,
    "runId" TEXT,
    "stepKey" TEXT,
    "kind" "DeviceTaskKind" NOT NULL,
    "status" "DeviceTaskStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT,
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "error" JSONB,
    "leaseId" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "deadlineAt" TIMESTAMP(3),
    "progress" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "terminalAt" TIMESTAMP(3),

    CONSTRAINT "DeviceTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceArtifact" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "DeviceArtifactKind" NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "storageRelPath" TEXT NOT NULL,
    "redacted" BOOLEAN NOT NULL DEFAULT false,
    "clientDeclaredRedacted" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Device_tokenHash_key" ON "Device"("tokenHash");

-- CreateIndex
CREATE INDEX "Device_ownerUserId_status_idx" ON "Device"("ownerUserId", "status");

-- CreateIndex
CREATE INDEX "Device_status_lastSeenAt_idx" ON "Device"("status", "lastSeenAt");

-- CreateIndex
CREATE INDEX "Device_tokenPrefix_idx" ON "Device"("tokenPrefix");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceEnrollment_codeHash_key" ON "DeviceEnrollment"("codeHash");

-- CreateIndex
CREATE INDEX "DeviceEnrollment_deviceId_createdAt_idx" ON "DeviceEnrollment"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceEnrollment_expiresAt_idx" ON "DeviceEnrollment"("expiresAt");

-- CreateIndex
CREATE INDEX "AgentDevice_deviceId_idx" ON "AgentDevice"("deviceId");

-- CreateIndex
CREATE INDEX "DeviceTask_deviceId_status_idx" ON "DeviceTask"("deviceId", "status");

-- CreateIndex
CREATE INDEX "DeviceTask_status_leaseExpiresAt_idx" ON "DeviceTask"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "DeviceTask_status_deadlineAt_idx" ON "DeviceTask"("status", "deadlineAt");

-- CreateIndex
CREATE INDEX "DeviceTask_agentId_createdAt_idx" ON "DeviceTask"("agentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceTask_deviceId_idempotencyKey_key" ON "DeviceTask"("deviceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "DeviceArtifact_deviceId_createdAt_idx" ON "DeviceArtifact"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceArtifact_expiresAt_idx" ON "DeviceArtifact"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceArtifact_taskId_seq_key" ON "DeviceArtifact"("taskId", "seq");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceEnrollment" ADD CONSTRAINT "DeviceEnrollment_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentDevice" ADD CONSTRAINT "AgentDevice_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentDevice" ADD CONSTRAINT "AgentDevice_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceTask" ADD CONSTRAINT "DeviceTask_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceArtifact" ADD CONSTRAINT "DeviceArtifact_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "DeviceTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceArtifact" ADD CONSTRAINT "DeviceArtifact_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
