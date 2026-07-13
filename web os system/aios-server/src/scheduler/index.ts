// BullMQ-backed scheduler. Owns three queues (runs, notify, sync), keeps
// repeatable jobs in sync with the `Schedule` table, and fires workflow runs
// / notifications on trigger. Must never throw out of startScheduler() — if
// Redis is unreachable the rest of the server still has to boot.
import { Queue, Worker, QueueEvents, type Job } from 'bullmq';
// cron-parser v4 is CommonJS; Node's ESM named-export detection can't see
// `parseExpression`, so import the default (module.exports) and destructure.
import cronParser from 'cron-parser';

const { parseExpression } = cronParser;
import { config } from '../config.js';
import { prisma } from '../lib/db.js';
import { hub } from '../ws/hub.js';
import { audit } from '../lib/audit.js';

interface RunJobData {
  workflowId: string;
  input?: unknown;
  triggeredBy: string;
  scheduleId?: string;
}

interface NotifyJobData {
  bindingId?: string;
  to?: string;
  text: string;
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
type SyncJobData = Record<string, unknown>;

let connection: { url: string } | undefined;

let runsQueue: Queue<RunJobData> | undefined;
let notifyQueue: Queue<NotifyJobData> | undefined;
let syncQueue: Queue<SyncJobData> | undefined;

let runsWorker: Worker<RunJobData> | undefined;
let notifyWorker: Worker<NotifyJobData> | undefined;
let syncWorker: Worker<SyncJobData> | undefined;

let runsEvents: QueueEvents | undefined;

let started = false;

const SCHEDULER_PREFIX = 'sched:';

function schedulerId(scheduleId: string): string {
  return `${SCHEDULER_PREFIX}${scheduleId}`;
}

/** Compute the next fire time for a cron expression in a given timezone. */
function computeNextFireAt(cronExpr: string, tz: string, from = new Date()): Date | null {
  try {
    const interval = parseExpression(cronExpr, { currentDate: from, tz });
    return interval.next().toDate();
  } catch (e) {
    console.warn(`[scheduler] invalid cron "${cronExpr}" (tz=${tz}):`, e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Create/update the BullMQ repeatable job (job scheduler) for a single
 * Schedule row, and persist its computed nextFireAt. Safe to call whenever a
 * Schedule's cron/timezone/enabled state changes.
 */
export async function syncSchedule(scheduleId: string): Promise<void> {
  if (!runsQueue) return; // scheduler not running (e.g. Redis down) — no-op
  const schedule = await prisma.schedule.findUnique({ where: { id: scheduleId } });
  if (!schedule) {
    await removeSchedule(scheduleId);
    return;
  }
  if (!schedule.enabled) {
    await removeSchedule(scheduleId);
    return;
  }

  const tz = schedule.timezone || config.tz;
  const nextFireAt = computeNextFireAt(schedule.cron, tz);
  if (!nextFireAt) return; // bad cron expression — leave existing scheduler alone

  try {
    await runsQueue.upsertJobScheduler(
      schedulerId(schedule.id),
      { pattern: schedule.cron, tz },
      {
        name: 'workflow-run',
        data: {
          workflowId: schedule.workflowId,
          triggeredBy: 'schedule',
          scheduleId: schedule.id,
        },
      },
    );
  } catch (e) {
    console.warn(`[scheduler] failed to upsert job scheduler for ${scheduleId}:`, e instanceof Error ? e.message : e);
    return;
  }

  await prisma.schedule.update({ where: { id: schedule.id }, data: { nextFireAt } }).catch(() => {});
}

/** Remove the BullMQ repeatable job for a schedule (e.g. disabled/deleted). */
export async function removeSchedule(scheduleId: string): Promise<void> {
  if (!runsQueue) return;
  try {
    await runsQueue.removeJobScheduler(schedulerId(scheduleId));
  } catch {
    // already gone — fine
  }
}

export function getQueues() {
  return { runs: runsQueue, notify: notifyQueue, sync: syncQueue };
}

async function runWorkflowRunJob(job: Job<RunJobData>): Promise<unknown> {
  const { workflowId, input, triggeredBy, scheduleId } = job.data;

  if (scheduleId) {
    hub.publish('schedule.fired', { scheduleId, workflowId, jobId: job.id, at: new Date().toISOString() });
    const schedule = await prisma.schedule.findUnique({ where: { id: scheduleId } });
    if (schedule) {
      const tz = schedule.timezone || config.tz;
      const nextFireAt = computeNextFireAt(schedule.cron, tz);
      await prisma.schedule
        .update({ where: { id: scheduleId }, data: { lastFiredAt: new Date(), nextFireAt: nextFireAt ?? undefined } })
        .catch(() => {});
    }
  }

  hub.publish('workflow.triggered', { workflowId, triggeredBy, jobId: job.id });

  try {
    const runnerPath = '../workflow/runner.js';
    const mod: any = await import(runnerPath);
    if (typeof mod.runWorkflow !== 'function') {
      throw new Error('workflow/runner.js does not export runWorkflow');
    }
    return await mod.runWorkflow(workflowId, input ?? {}, triggeredBy);
  } catch (e: any) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND') {
      console.warn('[scheduler] workflow/runner.js not present yet — skipping run', workflowId);
      return null;
    }
    await audit(null, 'workflow.run.failed', 'Workflow', workflowId, { error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

async function runNotifyJob(job: Job<NotifyJobData>): Promise<unknown> {
  const { bindingId, to, text } = job.data;
  try {
    const mod: any = await import('../channels/line.js');
    if (bindingId && typeof mod.pushToBinding === 'function') {
      return await mod.pushToBinding(bindingId, text);
    }
    if (to && typeof mod.pushMessage === 'function') {
      return await mod.pushMessage(to, text);
    }
    console.warn('[scheduler] notify job missing bindingId/to or channels/line.js missing expected export');
    return null;
  } catch (e: any) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND') {
      console.warn('[scheduler] channels/line.js not present yet — dropping notify job');
      return null;
    }
    throw e;
  }
}

async function runSyncJob(_job: Job<SyncJobData>): Promise<unknown> {
  // Placeholder hook for future cloud-account sync jobs; other modules can
  // enqueue onto `getQueues().sync` once that logic exists.
  return null;
}

/** On boot: fire any enabled schedule whose stored nextFireAt already passed. */
async function catchUpMissedSchedules(): Promise<void> {
  if (!runsQueue) return;
  const now = new Date();
  const overdue = await prisma.schedule.findMany({
    where: { enabled: true, nextFireAt: { lt: now } },
  });
  for (const schedule of overdue) {
    try {
      await runsQueue.add(
        'workflow-run',
        { workflowId: schedule.workflowId, triggeredBy: 'schedule-catchup', scheduleId: schedule.id },
        { removeOnComplete: true, removeOnFail: 50 },
      );
    } catch (e) {
      console.warn(`[scheduler] catch-up enqueue failed for schedule ${schedule.id}:`, e instanceof Error ? e.message : e);
    }
    // Realign nextFireAt regardless of enqueue outcome.
    const tz = schedule.timezone || config.tz;
    const nextFireAt = computeNextFireAt(schedule.cron, tz, now);
    await prisma.schedule.update({ where: { id: schedule.id }, data: { nextFireAt: nextFireAt ?? undefined } }).catch(() => {});
  }
}

/**
 * Start the scheduler: connect queues/workers to Redis, load all enabled
 * Schedule rows and (re)register their BullMQ job schedulers, then run
 * catch-up for anything overdue. Never throws — logs a warning and returns
 * if Redis is unavailable so the rest of the server can still boot.
 */
export async function startScheduler(): Promise<void> {
  if (started) return;

  try {
    connection = { url: config.redisUrl };

    runsQueue = new Queue<RunJobData>('runs', { connection });
    notifyQueue = new Queue<NotifyJobData>('notify', {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      },
    });
    syncQueue = new Queue<SyncJobData>('sync', { connection });

    // Fail fast if Redis is actually unreachable rather than silently
    // queueing commands forever.
    await runsQueue.waitUntilReady();
    await notifyQueue.waitUntilReady();
    await syncQueue.waitUntilReady();

    runsWorker = new Worker<RunJobData>(
      'runs',
      async (job) => runWorkflowRunJob(job),
      { connection, concurrency: 2 },
    );
    notifyWorker = new Worker<NotifyJobData>(
      'notify',
      async (job) => runNotifyJob(job),
      { connection, concurrency: 5 },
    );
    syncWorker = new Worker<SyncJobData>(
      'sync',
      async (job) => runSyncJob(job),
      { connection, concurrency: 2 },
    );

    runsWorker.on('failed', (job, err) => {
      console.warn(`[scheduler] runs job ${job?.id} failed:`, err.message);
    });
    notifyWorker.on('failed', (job, err) => {
      console.warn(`[scheduler] notify job ${job?.id} failed:`, err.message);
    });

    runsEvents = new QueueEvents('runs', { connection });

    started = true;

    // Register the default retry/backoff policy for notify jobs at add-time
    // via a small wrapper; consumers can still override per-call.
    const schedules = await prisma.schedule.findMany({ where: { enabled: true } });
    for (const schedule of schedules) {
      await syncSchedule(schedule.id);
    }

    await catchUpMissedSchedules();

    console.log(`[scheduler] started — ${schedules.length} enabled schedule(s) registered`);
  } catch (e) {
    console.warn('[scheduler] Redis unavailable or scheduler failed to start — continuing without it:', e instanceof Error ? e.message : e);
    await stopScheduler().catch(() => {});
    runsQueue = undefined;
    notifyQueue = undefined;
    syncQueue = undefined;
    started = false;
  }
}

/** Default job options helper for notify jobs: 3 retries, exponential backoff. */
export function notifyJobOptions() {
  return {
    attempts: 3,
    backoff: { type: 'exponential' as const, delay: 2000 },
    removeOnComplete: true,
    removeOnFail: 100,
  };
}

async function stopScheduler(): Promise<void> {
  await Promise.allSettled([
    runsWorker?.close(),
    notifyWorker?.close(),
    syncWorker?.close(),
    runsEvents?.close(),
    runsQueue?.close(),
    notifyQueue?.close(),
    syncQueue?.close(),
  ]);
  runsWorker = undefined;
  notifyWorker = undefined;
  syncWorker = undefined;
  runsEvents = undefined;
}
