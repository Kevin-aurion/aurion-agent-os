-- AlterTable
ALTER TABLE "SkillVersion" ADD COLUMN     "schemaVersion" TEXT,
ADD COLUMN     "specJson" JSONB;
