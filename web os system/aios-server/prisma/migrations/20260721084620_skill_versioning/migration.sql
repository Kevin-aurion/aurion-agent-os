-- AlterTable
ALTER TABLE "Skill" ADD COLUMN     "canaryVersionId" TEXT,
ADD COLUMN     "stableVersionId" TEXT;

-- CreateTable
CREATE TABLE "SkillVersion" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "contentMd" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'canary',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkillVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SkillVersion_skillId_channel_idx" ON "SkillVersion"("skillId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "SkillVersion_skillId_version_key" ON "SkillVersion"("skillId", "version");
