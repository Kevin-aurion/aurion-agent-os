-- CreateEnum
CREATE TYPE "DeviceMcpStatus" AS ENUM ('REQUESTED', 'INSTALLING', 'READY', 'ERROR', 'DISABLED');

-- AlterEnum
ALTER TYPE "DeviceTaskKind" ADD VALUE 'MCP_INSTALL';

-- AlterTable
ALTER TABLE "DeviceTask" ADD COLUMN     "confirmationArtifactId" TEXT,
ADD COLUMN     "confirmationRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "confirmedBy" TEXT,
ADD COLUMN     "requestedByUserId" TEXT;

-- CreateTable
CREATE TABLE "DeviceMcpInstallation" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "mcpKey" TEXT NOT NULL,
    "packageName" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "status" "DeviceMcpStatus" NOT NULL DEFAULT 'REQUESTED',
    "toolAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "riskTier" TEXT NOT NULL DEFAULT 'medium',
    "approvalRequired" BOOLEAN NOT NULL DEFAULT false,
    "installedBy" TEXT,
    "lastHealthAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceMcpInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeviceMcpInstallation_mcpKey_status_idx" ON "DeviceMcpInstallation"("mcpKey", "status");

-- CreateIndex
CREATE INDEX "DeviceMcpInstallation_deviceId_status_idx" ON "DeviceMcpInstallation"("deviceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceMcpInstallation_deviceId_mcpKey_key" ON "DeviceMcpInstallation"("deviceId", "mcpKey");

-- CreateIndex
CREATE INDEX "DeviceTask_requestedByUserId_status_idx" ON "DeviceTask"("requestedByUserId", "status");

-- AddForeignKey
ALTER TABLE "DeviceMcpInstallation" ADD CONSTRAINT "DeviceMcpInstallation_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
