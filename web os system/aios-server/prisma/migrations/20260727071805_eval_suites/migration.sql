-- CreateEnum
CREATE TYPE "EvalCaseKind" AS ENUM ('POSITIVE_TRIGGER', 'NEGATIVE_TRIGGER', 'CONFUSION_PAIR', 'TRAJECTORY', 'OUTPUT_RUBRIC', 'PROMPT_INJECTION', 'RED_TEAM');

-- CreateEnum
CREATE TYPE "EvalRunStatus" AS ENUM ('PENDING', 'RUNNING', 'PASSED', 'FAILED', 'ERROR');

-- CreateEnum
CREATE TYPE "EvalResultStatus" AS ENUM ('PASS', 'FAIL', 'ERROR', 'SKIPPED');

-- CreateTable
CREATE TABLE "EvalSuite" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvalSuite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvalCase" (
    "id" TEXT NOT NULL,
    "suiteId" TEXT NOT NULL,
    "kind" "EvalCaseKind" NOT NULL,
    "name" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "expected" JSONB,
    "requiredTools" TEXT[],
    "forbiddenTools" TEXT[],
    "weight" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvalCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvalRun" (
    "id" TEXT NOT NULL,
    "suiteId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "candidateVersionId" TEXT,
    "executeEngine" "Engine" NOT NULL,
    "verifyEngine" "Engine" NOT NULL,
    "status" "EvalRunStatus" NOT NULL DEFAULT 'PENDING',
    "totalCases" INTEGER NOT NULL DEFAULT 0,
    "passedCases" INTEGER NOT NULL DEFAULT 0,
    "failedCases" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "triggeredBy" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "EvalRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvalResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "status" "EvalResultStatus" NOT NULL,
    "score" DOUBLE PRECISION,
    "engine" "Engine",
    "deterministic" BOOLEAN NOT NULL DEFAULT true,
    "latencyMs" INTEGER,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "evidence" TEXT NOT NULL DEFAULT '',
    "highRisk" BOOLEAN NOT NULL DEFAULT false,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvalResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EvalSuite_skillId_idx" ON "EvalSuite"("skillId");

-- CreateIndex
CREATE INDEX "EvalCase_suiteId_idx" ON "EvalCase"("suiteId");

-- CreateIndex
CREATE INDEX "EvalRun_suiteId_idx" ON "EvalRun"("suiteId");

-- CreateIndex
CREATE INDEX "EvalRun_skillId_candidateVersionId_idx" ON "EvalRun"("skillId", "candidateVersionId");

-- CreateIndex
CREATE INDEX "EvalResult_runId_idx" ON "EvalResult"("runId");

-- CreateIndex
CREATE INDEX "EvalResult_caseId_idx" ON "EvalResult"("caseId");

-- AddForeignKey
ALTER TABLE "EvalCase" ADD CONSTRAINT "EvalCase_suiteId_fkey" FOREIGN KEY ("suiteId") REFERENCES "EvalSuite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalRun" ADD CONSTRAINT "EvalRun_suiteId_fkey" FOREIGN KEY ("suiteId") REFERENCES "EvalSuite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalResult" ADD CONSTRAINT "EvalResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EvalRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalResult" ADD CONSTRAINT "EvalResult_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "EvalCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
