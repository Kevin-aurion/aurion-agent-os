/**
 * Workbench V2 — Skill Palette / authorization / schedule projection.
 * Pure functions only: immutable, no I/O, no React.
 * End-user strings use business Chinese; never leak technical tokens.
 */

// ── Status / kind / capability labels ───────────────────────────────────────

export function skillStatusLabelZh(reviewStatus: string): string {
  switch (reviewStatus) {
    case 'CONFIRMED':
      return '可以使用';
    case 'AWAITING_USER_CONFIRM':
      return '等待訓練師確認';
    case 'DRAFT':
      return '草稿';
    case 'REJECTED':
      return '已退回';
    default:
      return '審核中';
  }
}

export function skillKindLabelZh(kind: string): string {
  switch (kind) {
    case 'RECORDED':
      return '錄製示範技能';
    case 'COMPUTER_CONTROL':
      return '電腦操作技能';
    case 'BUILTIN':
      return '內建技能';
    case 'PROMPT':
      return '一般技能';
    default:
      return '一般技能';
  }
}

const CAPABILITY_LABELS: Record<string, string> = {
  webSearch: '上網查資料',
  computerUse: '操作電腦完成畫面工作',
  sendEmail: '寄送郵件',
  cloudWrite: '建立或修改雲端文件',
  shell: '執行進階自動化',
  cloudEmbedding: '整理長期記憶',
  sandbox: '在隔離環境試做',
};

/** Primary capabilities shown in the authorization section (fixed order). */
const PRIMARY_CAPABILITIES = [
  'webSearch',
  'computerUse',
  'sendEmail',
  'cloudWrite',
  'shell',
] as const;

export function capabilityLabelZh(key: string): string | null {
  return CAPABILITY_LABELS[key] ?? null;
}

export function projectAuthorization(
  restrictions: Record<string, unknown> | null | undefined,
): Array<{ key: string; label: string; allowed: boolean }> {
  const src =
    restrictions !== null &&
    restrictions !== undefined &&
    typeof restrictions === 'object' &&
    !Array.isArray(restrictions)
      ? restrictions
      : null;

  return PRIMARY_CAPABILITIES.map((key) => ({
    key,
    label: CAPABILITY_LABELS[key]!,
    // fail-closed: only exact true counts as allowed
    allowed: src !== null && src[key] === true,
  }));
}

// ── Skill palette ───────────────────────────────────────────────────────────

export type PaletteSkillIn = {
  skillId: string;
  skill?: {
    name?: string;
    reviewStatus?: string;
    kind?: string;
  } | null;
};

export type PaletteSkillOut = {
  skillId: string;
  name: string;
  statusLabel: string;
  kindLabel: string;
  usable: boolean;
};

export function projectSkillPalette(
  skills: Array<PaletteSkillIn> | null | undefined,
): Array<PaletteSkillOut> {
  if (!Array.isArray(skills)) return [];
  return skills.map((row) => {
    const skill = row?.skill ?? null;
    const reviewStatus = skill?.reviewStatus;
    const kind = skill?.kind;
    return {
      skillId: row.skillId,
      name: (skill?.name && skill.name.trim()) || '未命名技能',
      statusLabel: skillStatusLabelZh(
        typeof reviewStatus === 'string' ? reviewStatus : '',
      ),
      kindLabel: skillKindLabelZh(typeof kind === 'string' ? kind : ''),
      usable: reviewStatus === 'CONFIRMED',
    };
  });
}

// ── Cron / trigger ──────────────────────────────────────────────────────────

const WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六'] as const;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Describe common 5-field cron expressions in business Chinese.
 * Never returns the raw cron string.
 */
export function describeCronZh(
  cron: string | null | undefined,
  _timezone?: string | null,
): string {
  if (typeof cron !== 'string') return '定期執行';
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return '定期執行';

  const [minRaw, hourRaw, domRaw, monRaw, dowRaw] = parts;

  // */N * * * * → every N minutes
  const everyMin = minRaw!.match(/^\*\/(\d+)$/);
  if (
    everyMin &&
    hourRaw === '*' &&
    domRaw === '*' &&
    monRaw === '*' &&
    dowRaw === '*'
  ) {
    const n = Number(everyMin[1]);
    if (Number.isInteger(n) && n > 0) return `每 ${n} 分鐘`;
    return '定期執行';
  }

  const minute = Number(minRaw);
  const hour = Number(hourRaw);
  if (
    !Number.isInteger(minute) ||
    !Number.isInteger(hour) ||
    minute < 0 ||
    minute > 59 ||
    hour < 0 ||
    hour > 23
  ) {
    return '定期執行';
  }
  const hhmm = `${pad2(hour)}:${pad2(minute)}`;

  // M H * * * → daily
  if (domRaw === '*' && monRaw === '*' && dowRaw === '*') {
    return `每天 ${hhmm}`;
  }

  // M H * * D → weekly (D may be comma-separated; take first)
  if (domRaw === '*' && monRaw === '*') {
    const firstDow = (dowRaw ?? '').split(',')[0]?.trim() ?? '';
    let d = Number(firstDow);
    if (firstDow === '7') d = 0;
    if (Number.isInteger(d) && d >= 0 && d <= 6) {
      return `每週${WEEKDAY_ZH[d]} ${hhmm}`;
    }
    return '定期執行';
  }

  // M H D * * → monthly
  if (monRaw === '*' && dowRaw === '*') {
    const day = Number(domRaw);
    if (Number.isInteger(day) && day >= 1 && day <= 31) {
      return `每月 ${day} 日 ${hhmm}`;
    }
    return '定期執行';
  }

  return '定期執行';
}

export function describeTriggerZh(trigger: unknown): string {
  if (trigger === null || trigger === undefined || typeof trigger !== 'object') {
    return '依設定執行';
  }
  const t = trigger as { type?: unknown; cron?: unknown; keywords?: unknown };
  const type = typeof t.type === 'string' ? t.type : '';

  switch (type) {
    case 'schedule': {
      const cron = typeof t.cron === 'string' ? t.cron : null;
      return describeCronZh(cron);
    }
    case 'keyword': {
      const kws = Array.isArray(t.keywords)
        ? t.keywords.filter((k): k is string => typeof k === 'string' && k.length > 0)
        : [];
      if (kws.length === 0) return '聽到關鍵字時執行';
      const shown = kws.slice(0, 3);
      const more = kws.length > 3 ? '等' : '';
      return `聽到「${shown.join('、')}」${more}時執行`;
    }
    case 'manual':
      return '手動交辦時執行';
    case 'webhook':
      return '由外部系統通知時執行';
    case 'event':
      return '系統事件發生時執行';
    default:
      return '依設定執行';
  }
}

export function lastRunLabelZh(status: string | null | undefined): string {
  switch (status) {
    case 'SUCCEEDED':
      return '上次順利完成';
    case 'FAILED':
      return '上次未完成';
    case 'CANCELLED':
      return '上次已取消';
    case 'RUNNING':
      return '正在執行';
    case 'AWAITING_REVIEW':
      return '等待訓練師核准';
    default:
      return '還沒有執行紀錄';
  }
}

// ── Schedules projection ────────────────────────────────────────────────────

export type ScheduleRowOut = {
  workflowId: string;
  name: string;
  triggerLabel: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastResultLabel: string;
  lastResultAt: string | null;
  pausedReason: string | null;
};

type LooseWorkflow = {
  id?: unknown;
  name?: unknown;
  enabled?: unknown;
  trigger?: unknown;
  schedule?: {
    enabled?: unknown;
    nextFireAt?: unknown;
    cron?: unknown;
  } | null;
};

type LooseRun = {
  workflowId?: unknown;
  status?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
};

function pickLatestRun(
  runs: LooseRun[],
  workflowId: string,
): LooseRun | null {
  let best: LooseRun | null = null;
  let bestTs = -Infinity;
  for (const r of runs) {
    if (r?.workflowId !== workflowId) continue;
    const ts =
      typeof r.startedAt === 'string' ? Date.parse(r.startedAt) : Number.NaN;
    const score = Number.isFinite(ts) ? ts : -Infinity;
    if (best === null || score > bestTs) {
      best = r;
      bestTs = score;
    }
  }
  return best;
}

export function projectSchedules(
  workflows: unknown,
  runs: unknown,
): Array<ScheduleRowOut> {
  const wfList: LooseWorkflow[] = Array.isArray(workflows)
    ? (workflows as LooseWorkflow[])
    : [];
  const runList: LooseRun[] = Array.isArray(runs) ? (runs as LooseRun[]) : [];

  return wfList.map((wf) => {
    const workflowId = typeof wf?.id === 'string' ? wf.id : '';
    const name =
      typeof wf?.name === 'string' && wf.name.trim() ? wf.name : '未命名工作';
    const enabled = wf?.enabled === true;
    const trigger = wf?.trigger;
    const schedule = wf?.schedule ?? null;
    const triggerLabel = describeTriggerZh(trigger);

    const scheduleEnabled = schedule !== null && schedule?.enabled === true;
    const nextFireAt =
      schedule && typeof schedule.nextFireAt === 'string' ? schedule.nextFireAt : null;
    const nextRunAt =
      enabled && scheduleEnabled && nextFireAt ? nextFireAt : null;

    let pausedReason: string | null = null;
    if (wf?.enabled === false) {
      pausedReason = '訓練師已暫停這項工作';
    } else if (
      enabled &&
      trigger !== null &&
      typeof trigger === 'object' &&
      (trigger as { type?: unknown }).type === 'schedule' &&
      schedule !== null &&
      schedule?.enabled === false
    ) {
      pausedReason = '排程暫停中，請洽訓練師';
    }

    const latest = pickLatestRun(runList, workflowId);
    const lastResultLabel = lastRunLabelZh(
      latest && typeof latest.status === 'string' ? latest.status : null,
    );
    let lastResultAt: string | null = null;
    if (latest) {
      if (typeof latest.finishedAt === 'string') lastResultAt = latest.finishedAt;
      else if (typeof latest.startedAt === 'string') lastResultAt = latest.startedAt;
    }

    return {
      workflowId,
      name,
      triggerLabel,
      enabled,
      nextRunAt,
      lastResultLabel,
      lastResultAt,
      pausedReason,
    };
  });
}

// ── UI action contract (always read-only on workbench) ──────────────────────

export function paletteControls(isFde: boolean): {
  canToggleSchedule: false;
  canEditSkills: false;
  canChangeAuthorization: false;
  canFullAuto: false;
  showAdminLink: boolean;
} {
  return {
    canToggleSchedule: false as const,
    canEditSkills: false as const,
    canChangeAuthorization: false as const,
    canFullAuto: false as const,
    showAdminLink: isFde,
  };
}
