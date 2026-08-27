'use client';

import { AlertTriangle } from 'lucide-react';
import { Spinner, StatusBadge } from '@/components/ui';
import {
  deriveDraftGaps,
  draftCardActions,
  draftNextAction,
} from '@/lib/teachjourney';
import type { SkillUnderstanding } from './types';

export function UnderstandingList({
  title,
  items,
  icon,
}: {
  title: string;
  items: string[];
  icon?: React.ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted">{title}</div>
      <ul className="space-y-1">
        {items.map((item, idx) => (
          <li key={idx} className="flex items-start gap-1.5 text-sm">
            {icon ?? <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted" />}
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Skill draft card: shows understanding + role-gated actions.
 * - FDE: confirm + attach (trainer APIs)
 * - MEMBER: propose only (never auto-confirm)
 */
export function SkillDraftCard({
  skillId,
  name,
  reviewStatus,
  understanding,
  statusNote,
  isFde,
  confirming,
  proposing,
  onConfirm,
  onPropose,
}: {
  skillId: string;
  name: string;
  reviewStatus: string;
  understanding: SkillUnderstanding | null;
  statusNote?: string;
  isFde: boolean;
  confirming?: boolean;
  proposing?: boolean;
  onConfirm: (skillId: string) => void;
  onPropose: (skillId: string, name: string) => void;
}) {
  const u = understanding;
  const gaps = deriveDraftGaps(u);
  const nextAction = draftNextAction({ reviewStatus, isFde, statusNote });
  const { showConfirm, showPropose } = draftCardActions({ isFde, reviewStatus, statusNote });

  return (
    <div className="card space-y-3 border-brand/20 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">{name}</h3>
        <StatusBadge status={reviewStatus} />
      </div>
      {u?.summary && <p className="text-sm">{u.summary}</p>}
      {u && (
        <>
          <UnderstandingList title="能力" items={u.capabilities} />
          <UnderstandingList title="讀取資料" items={u.data_read} />
          <UnderstandingList title="寫入/修改資料" items={u.data_written} />
          <UnderstandingList title="外部呼叫" items={u.external_calls} />
          {u.irreversible_actions.length > 0 && (
            <UnderstandingList
              title="不可逆動作"
              items={u.irreversible_actions}
              icon={<AlertTriangle className="h-3.5 w-3.5 text-rose-400" />}
            />
          )}
          {u.risks.length > 0 && (
            <UnderstandingList
              title="風險"
              items={u.risks}
              icon={<AlertTriangle className="h-3.5 w-3.5 text-amber-400" />}
            />
          )}
        </>
      )}
      {gaps.length > 0 && (
        <div className="space-y-1 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-400/80" />
            資訊缺口
          </div>
          <ul className="space-y-1">
            {gaps.map((g, idx) => (
              <li key={idx} className="flex items-start gap-1.5 text-sm text-muted">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-amber-400/60" />
                <span>{g}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {statusNote && <p className="text-sm text-emerald-400">{statusNote}</p>}
      {(showConfirm || showPropose) && (
        <div className="flex justify-end gap-2 pt-1">
          {showConfirm && (
            <button
              type="button"
              className="btn-primary"
              disabled={confirming}
              onClick={() => onConfirm(skillId)}
            >
              {confirming && <Spinner className="border-white/40 border-t-white" />}
              ✅ 確認掛載
            </button>
          )}
          {showPropose && (
            <button
              type="button"
              className="btn-primary"
              disabled={proposing}
              onClick={() => onPropose(skillId, name)}
            >
              {proposing && <Spinner className="border-white/40 border-t-white" />}
              送出提案
            </button>
          )}
        </div>
      )}
      <p className="text-xs text-muted">下一步：{nextAction}</p>
    </div>
  );
}
