/**
 * Workbench V2 teach journey pure helpers.
 * No React, no IO — upload validation, draft gaps, next actions, recording target gate.
 */
import type { SkillUnderstanding } from '@/components/workbench/types';

export const MAX_TEACH_UPLOAD_BYTES = 200_000;

export type TeachUploadCheck =
  | { ok: true; kind: 'md' | 'txt' }
  | { ok: false; reason: string };

function extOf(name: string): string {
  const base = name.trim();
  const i = base.lastIndexOf('.');
  if (i < 0 || i === base.length - 1) return '';
  return base.slice(i + 1).toLowerCase();
}

/**
 * Accept only .md / .markdown (kind 'md') and .txt (kind 'txt').
 * Extension match is case-insensitive. size 0 or > MAX → reject.
 */
export function validateTeachUpload(input: { name: string; size: number }): TeachUploadCheck {
  const size = typeof input.size === 'number' && Number.isFinite(input.size) ? input.size : -1;
  if (size === 0) {
    return { ok: false, reason: '文件是空的' };
  }
  if (size < 0 || size > MAX_TEACH_UPLOAD_BYTES) {
    return { ok: false, reason: '文件太大，請小於 200KB' };
  }
  const ext = extOf(input.name ?? '');
  if (ext === 'md' || ext === 'markdown') {
    return { ok: true, kind: 'md' };
  }
  if (ext === 'txt') {
    return { ok: true, kind: 'txt' };
  }
  return { ok: false, reason: '只支援 .md 或 .txt 文件' };
}

/**
 * Deterministic train/message payload from an uploaded teaching document.
 * Empty/whitespace text throws with business-language Error.
 */
export function buildUploadTrainMessage(fileName: string, text: string): string {
  const body = (text ?? '').trim();
  if (!body) {
    throw new Error('文件是空的，請上傳有內容的教學文件');
  }
  const name = (fileName ?? '').trim() || '未命名文件';
  return [
    `以下是使用者上傳的教學文件「${name}」。`,
    '請整理成技能草稿，保留可重複執行的步驟與注意事項。',
    '',
    '--- 文件內容 ---',
    body,
    '--- 文件結束 ---',
  ].join('\n');
}

/**
 * Derive missing understanding fields for the draft card "資訊缺口" block.
 * external_calls / irreversible_actions / risks empty are NOT gaps.
 */
export function deriveDraftGaps(u: SkillUnderstanding | null): string[] {
  if (u === null) {
    return ['尚未產生理解結果，請再補充說明一次'];
  }
  const gaps: string[] = [];
  if (!u.summary || !u.summary.trim()) {
    gaps.push('還不清楚這個技能的目的，請補充說明');
  }
  if (!Array.isArray(u.capabilities) || u.capabilities.length === 0) {
    gaps.push('還不清楚這個技能包含哪些步驟');
  }
  const reads = Array.isArray(u.data_read) ? u.data_read : [];
  const writes = Array.isArray(u.data_written) ? u.data_written : [];
  if (reads.length === 0 && writes.length === 0) {
    gaps.push('還不知道會讀取或修改哪些資料');
  }
  return gaps;
}

/**
 * Business-language "下一步" for the draft card footer.
 */
export function draftNextAction(input: {
  reviewStatus: string;
  isFde: boolean;
  statusNote?: string;
}): string {
  if (input.reviewStatus === 'CONFIRMED') {
    return '已確認並掛載，可以開始交代工作';
  }
  if (input.statusNote?.includes('提案')) {
    return '提案已送出，等待訓練師審核後才會生效';
  }
  if (input.isFde) {
    return '由你確認掛載，或退回請對方補充';
  }
  return '送出提案，交給訓練師審核後才會生效';
}

/**
 * Button visibility for SkillDraftCard.
 * showConfirm is only ever true for FDE; MEMBER is always false.
 */
export function draftCardActions(input: {
  isFde: boolean;
  reviewStatus: string;
  statusNote?: string;
}): { showConfirm: boolean; showPropose: boolean } {
  if (input.reviewStatus === 'CONFIRMED' || input.statusNote?.includes('提案')) {
    return { showConfirm: false, showPropose: false };
  }
  if (input.isFde) {
    return { showConfirm: true, showPropose: false };
  }
  return { showConfirm: false, showPropose: true };
}

/**
 * Gate recording import when the bound agent differs from the selected agent.
 */
export function recordingImportTarget(
  boundAgentId: string | null | undefined,
  selectedAgentId: string | null | undefined,
): { ok: true; agentId: string } | { ok: false; reason: string } {
  const bound =
    typeof boundAgentId === 'string' && boundAgentId.length > 0 ? boundAgentId : null;
  const selected =
    typeof selectedAgentId === 'string' && selectedAgentId.length > 0 ? selectedAgentId : null;

  if (!bound && !selected) {
    return { ok: false, reason: '請先選擇要訓練的 AI 員工' };
  }
  if (bound && selected && bound !== selected) {
    return {
      ok: false,
      reason: '這段錄製是在另一位 AI 員工上開始的，請先切回那位員工再結束錄製。',
    };
  }
  return { ok: true, agentId: (bound ?? selected)! };
}
