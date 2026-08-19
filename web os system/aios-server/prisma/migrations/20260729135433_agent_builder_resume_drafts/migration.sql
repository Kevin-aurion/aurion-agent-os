-- AlterTable
ALTER TABLE "AgentBuildSession" ADD COLUMN     "draftState" JSONB;

-- CreateTable
CREATE TABLE "AgentBuilderWorkspace" (
    "userId" TEXT NOT NULL,
    "newDraft" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentBuilderWorkspace_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "AgentBuilderWorkspace" ADD CONSTRAINT "AgentBuilderWorkspace_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
