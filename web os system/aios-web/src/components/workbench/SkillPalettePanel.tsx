'use client';

import Link from 'next/link';
import { Check } from 'lucide-react';
import { Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  paletteControls,
  projectAuthorization,
  projectSchedules,
  projectSkillPalette,
  type PaletteSkillIn,
} from '@/lib/skillpalette';

export function SkillPalettePanel({
  agentId,
  skills,
  restrictions,
  workflows,
  runs,
  isFde,
  loading,
}: {
  agentId: string | null;
  skills: Array<PaletteSkillIn> | undefined;
  restrictions: Record<string, unknown> | null | undefined;
  workflows: unknown[] | undefined;
  runs: unknown[] | undefined;
  isFde: boolean;
  loading?: boolean;
}) {
  const controls = paletteControls(isFde);
  const palette = projectSkillPalette(skills);
  const auth = projectAuthorization(restrictions);
  const schedules = projectSchedules(workflows, runs);

  if (loading) {
    return (
      <div className="flex justify-center border-b border-border p-4">
        <Spinner className="h-4 w-4" />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col">
      {/* ① Skills */}
      <div className="border-b border-border p-4">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">
          這位員工會的技能
        </div>
        {palette.length === 0 ? (
          <p className="text-xs text-muted">尚未掛載技能</p>
        ) : (
          <ul className="max-h-48 space-y-2 overflow-y-auto">
            {palette.map((s) => (
              <li key={s.skillId} className="flex items-start justify-between gap-2 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-medium">{s.name}</div>
                  <div className="truncate text-[11px] text-muted">{s.kindLabel}</div>
                </div>
                <span
                  className={cn(
                    'shrink-0 text-[11px]',
                    s.statusLabel === '可以使用' && 'text-emerald-400',
                    s.statusLabel === '等待訓練師確認' && 'text-amber-300',
                    s.statusLabel === '已退回' && 'text-rose-400',
                    s.statusLabel !== '可以使用' &&
                      s.statusLabel !== '等待訓練師確認' &&
                      s.statusLabel !== '已退回' &&
                      'text-muted',
                  )}
                >
                  {s.statusLabel}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ② Authorization */}
      <div className="border-b border-border p-4">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">
          已獲授權可以做的事
        </div>
        <ul className="space-y-1.5">
          {auth.map((item) => (
            <li key={item.key} className="flex items-center gap-2 text-sm">
              {item.allowed ? (
                <>
                  <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden />
                  <span>{item.label}</span>
                </>
              ) : (
                <span className="text-muted">
                  {item.label}
                  <span className="text-[11px]">（未開放）</span>
                </span>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-muted">權限由訓練師設定，這裡只能查看。</p>
      </div>

      {/* ③ Schedules */}
      <div className="border-b border-border p-4">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">
          排程與例行工作
        </div>
        {schedules.length === 0 ? (
          <p className="text-xs text-muted">目前沒有排程或例行工作</p>
        ) : (
          <ul className="max-h-56 space-y-3 overflow-y-auto">
            {schedules.map((row) => (
              <li key={row.workflowId} className="space-y-0.5 text-sm">
                <div className="font-medium">{row.name}</div>
                <div className="text-[11px] text-muted">{row.triggerLabel}</div>
                {row.nextRunAt && (
                  <div className="text-[11px] text-muted">
                    下次執行 ·{' '}
                    {(() => {
                      try {
                        return new Date(row.nextRunAt).toLocaleString('zh-TW');
                      } catch {
                        return '—';
                      }
                    })()}
                  </div>
                )}
                <div className="text-[11px] text-muted">
                  {row.lastResultLabel}
                  {row.lastResultAt
                    ? ` · ${(() => {
                        try {
                          return new Date(row.lastResultAt).toLocaleString('zh-TW');
                        } catch {
                          return '';
                        }
                      })()}`
                    : ''}
                </div>
                {row.pausedReason && (
                  <div className="text-[11px] text-amber-300">{row.pausedReason}</div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* FDE-only navigation link — never a mutation control */}
      {controls.showAdminLink && isFde && agentId && (
        <div className="border-b border-border p-4">
          <Link
            href={`/employees/${agentId}?tab=workflows`}
            className="block text-center text-[11px] text-brand hover:underline"
          >
            管理排程與技能（訓練師）
          </Link>
        </div>
      )}
    </div>
  );
}
