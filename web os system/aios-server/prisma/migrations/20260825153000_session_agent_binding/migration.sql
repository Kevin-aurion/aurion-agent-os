-- AlterTable
ALTER TABLE "AgentBuildSession" ADD COLUMN     "agentId" TEXT,
ADD COLUMN     "externalConversationId" TEXT,
ADD COLUMN     "externalConversationTitle" TEXT,
ADD COLUMN     "externalSource" TEXT;

-- Backfill phase-1 external identity from brief JSON (transcript.source as fallback).
UPDATE "AgentBuildSession" AS s
SET
  "externalConversationId" = NULLIF(BTRIM(s.brief->>'externalConversationId'), ''),
  "externalSource" = COALESCE(
    NULLIF(BTRIM(s.brief->>'externalSource'), ''),
    NULLIF(BTRIM(s.brief->>'source'), ''),
    (
      SELECT NULLIF(BTRIM(elem->>'source'), '')
      FROM jsonb_array_elements(
        CASE
          WHEN s.transcript IS NOT NULL AND jsonb_typeof(s.transcript::jsonb) = 'array' THEN s.transcript::jsonb
          ELSE '[]'::jsonb
        END
      ) AS elem
      WHERE COALESCE(BTRIM(elem->>'source'), '') <> ''
      LIMIT 1
    )
  ),
  "externalConversationTitle" = NULLIF(BTRIM(s.brief->>'externalConversationTitle'), '');

-- Duplicate (userId, source, conversationId) would violate the unique index.
-- Keep the latest row's binding; older copies stay in brief JSON only.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "userId", "externalSource", "externalConversationId"
      ORDER BY "updatedAt" DESC, "createdAt" DESC, id DESC
    ) AS rn
  FROM "AgentBuildSession"
  WHERE "externalConversationId" IS NOT NULL
)
UPDATE "AgentBuildSession" AS s
SET
  "externalConversationId" = NULL,
  "externalSource" = NULL,
  "externalConversationTitle" = NULL
FROM ranked
WHERE s.id = ranked.id
  AND ranked.rn > 1;

-- CreateIndex (phase-1 conversation identity)
CREATE UNIQUE INDEX "AgentBuildSession_external_binding_key" ON "AgentBuildSession"("userId", "externalSource", "externalConversationId");

-- Backfill phase-2 agent binding. Prefer builtAgentId, else targetAgentId.
-- Only the latest row per (userId, agentId) is bound so the partial unique index can be created.
WITH ranked AS (
  SELECT
    id,
    COALESCE("builtAgentId", "targetAgentId") AS bind_id,
    ROW_NUMBER() OVER (
      PARTITION BY "userId", COALESCE("builtAgentId", "targetAgentId")
      ORDER BY "updatedAt" DESC, "createdAt" DESC, id DESC
    ) AS rn
  FROM "AgentBuildSession"
  WHERE COALESCE("builtAgentId", "targetAgentId") IS NOT NULL
)
UPDATE "AgentBuildSession" AS s
SET "agentId" = ranked.bind_id
FROM ranked
WHERE s.id = ranked.id
  AND ranked.rn = 1;

-- Partial unique: one non-ABANDONED session per (userId, agentId).
CREATE UNIQUE INDEX "AgentBuildSession_user_agent_active_key"
  ON "AgentBuildSession"("userId", "agentId")
  WHERE "agentId" IS NOT NULL AND "status" <> 'ABANDONED';
