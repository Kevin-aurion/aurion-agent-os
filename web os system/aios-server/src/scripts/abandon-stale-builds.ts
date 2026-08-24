// Soft-abandon stale unsubmitted Agent Builder drafts for one owner.
// Default is dry-run. Never hard-deletes. Reuses abandonBuilderSession.
//
//   npx tsx src/scripts/abandon-stale-builds.ts --user <email 或 userId>
//   npx tsx src/scripts/abandon-stale-builds.ts --user <email 或 userId> --older-than 7 --apply
import 'dotenv/config';
import { prisma } from '../lib/db.js';
import { abandonBuilderSession } from '../lib/agentbuilder.js';

type Args = {
  user: string | undefined;
  olderThanDays: number;
  apply: boolean;
};

function parseArgs(argv: string[]): Args {
  let user: string | undefined;
  let olderThanDays = 0;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--user') {
      user = argv[++i];
    } else if (arg.startsWith('--user=')) {
      user = arg.slice('--user='.length);
    } else if (arg === '--older-than') {
      olderThanDays = Number(argv[++i]);
    } else if (arg.startsWith('--older-than=')) {
      olderThanDays = Number(arg.slice('--older-than='.length));
    } else if (arg === '--apply') {
      apply = true;
    }
  }
  return { user, olderThanDays, apply };
}

function transcriptLength(raw: unknown): number {
  return Array.isArray(raw) ? raw.length : 0;
}

function printUsage(): void {
  console.error('用法：npx tsx src/scripts/abandon-stale-builds.ts --user <email 或 userId> [--older-than <天>] [--apply]');
  console.error('預設 dry-run；加 --apply 才會把符合條件的 DISCOVERY/PLAN_READY 草稿軟刪為 ABANDONED。');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.user?.trim()) {
    printUsage();
    throw new Error('缺少 --user <email 或 userId>');
  }
  if (!Number.isFinite(args.olderThanDays) || args.olderThanDays < 0) {
    throw new Error('--older-than 必須是 ≥ 0 的數字（0 = 不限）');
  }

  const userKey = args.user.trim();
  const user = await prisma.user.findFirst({
    where: {
      deletedAt: null,
      OR: [{ id: userKey }, { email: userKey }],
    },
    select: { id: true, email: true },
  });
  if (!user) {
    throw new Error(`找不到使用者：${userKey}`);
  }

  const rows = await prisma.agentBuildSession.findMany({
    where: {
      userId: user.id,
      status: { in: ['DISCOVERY', 'PLAN_READY'] },
      builtAgentId: null,
      draftSkillIds: { isEmpty: true },
      ...(args.olderThanDays > 0
        ? { createdAt: { lt: new Date(Date.now() - args.olderThanDays * 86_400_000) } }
        : {}),
    },
    include: { _count: { select: { iterations: true } } },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`使用者 ${user.email} (${user.id})`);
  console.log(`符合條件：${rows.length} 筆（status ∈ DISCOVERY/PLAN_READY，無 builtAgentId，無 draftSkillIds${
    args.olderThanDays > 0 ? `，早於 ${args.olderThanDays} 天` : ''
  }）`);
  console.log(
    `${'id'.padEnd(12)}${'status'.padEnd(14)}${'createdAt'.padEnd(26)}${'iterations'.padEnd(14)}transcript`,
  );
  for (const row of rows) {
    console.log(
      `${row.id.slice(0, 10).padEnd(12)}${row.status.padEnd(14)}${row.createdAt.toISOString().padEnd(26)}${String(row._count.iterations).padEnd(14)}${transcriptLength(row.transcript)}`,
    );
  }

  if (!args.apply) {
    console.log(`將捨棄 ${rows.length} 筆（加 --apply 才會實際執行）`);
    return;
  }

  let abandoned = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const result = await abandonBuilderSession({
        sessionId: row.id,
        userId: user.id,
      });
      console.log(`applied ${row.id.slice(0, 10)} → ${result.status}`);
      abandoned += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`failed ${row.id.slice(0, 10)}: ${message}`);
    }
  }
  console.log(`結果：捨棄 ${abandoned} 筆，失敗 ${failed} 筆（軟刪，紀錄保留）`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
