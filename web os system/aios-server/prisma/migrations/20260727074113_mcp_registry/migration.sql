-- CreateEnum
CREATE TYPE "McpTransport" AS ENUM ('STDIO', 'LOOPBACK_HTTP', 'REMOTE_HTTP');

-- CreateEnum
CREATE TYPE "McpTrustTier" AS ENUM ('UNTRUSTED', 'TRUSTED', 'INTERNAL');

-- CreateTable
CREATE TABLE "McpServerRegistry" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "transport" "McpTransport" NOT NULL,
    "command" TEXT,
    "commandArgs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cwd" TEXT,
    "url" TEXT,
    "protocolVersion" TEXT NOT NULL DEFAULT '2024-11-05',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "trustTier" "McpTrustTier" NOT NULL DEFAULT 'UNTRUSTED',
    "credentialRef" TEXT,
    "allowedAgentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "toolAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "resourceAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "readWriteClass" TEXT NOT NULL DEFAULT 'read',
    "requiredRestrictions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "riskTier" TEXT NOT NULL DEFAULT 'medium',
    "approvalRequired" BOOLEAN NOT NULL DEFAULT false,
    "timeoutMs" INTEGER NOT NULL DEFAULT 12000,
    "healthStatus" TEXT NOT NULL DEFAULT 'unknown',
    "lastVersion" TEXT,
    "lastHealthAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpServerRegistry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "McpServerRegistry_serverId_key" ON "McpServerRegistry"("serverId");

-- CreateIndex
CREATE INDEX "McpServerRegistry_enabled_idx" ON "McpServerRegistry"("enabled");
