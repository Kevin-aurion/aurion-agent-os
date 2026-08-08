'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  Circle,
  GraduationCap,
  List,
  MessageSquare,
  Plus,
  Send,
  Shield,
  Sparkles,
  Square,
  Video,
  Wrench,
} from 'lucide-react';
import { API, ApiError } from '@/lib/api';
import { useAuth, isFdeRole } from '@/lib/auth';
import { useAwp, type AwpFrame } from '@/lib/awp';
import { AppShell } from '@/components/AppShell';
import { EmptyState, Spinner, StatusBadge } from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  AgentBuilderPanel,
  AgentBuilderRail,
} from '@/components/workbench/AgentBuilderPanel';
import { ChatRunTimeline } from '@/components/workbench/ChatRunTimeline';
import { SkillDraftCard } from '@/components/workbench/SkillDraftCard';
import { VoiceInput } from '@/components/workbench/VoiceInput';
import {
  type AgentDetail,
  type AgentFlows,
  type AgentListItem,
  type BuilderSession,
  type ChatMessage,
  type Conversation,
  type RecordingStatus,
  type RunStep,
  type SkillDetail,
  type TeachChatMsg,
  type TrainMessageResult,
  type WorkbenchMode,
  isRecordingActive,
  normalizeUnderstanding,
  parseSkillNameFromMd,
  recordingSessionStatus,
} from '@/components/workbench/types';

function relativeTime(iso?: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 60) return '剛剛';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分前`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小時前`;
  return `${Math.round(diffHr / 24)} 天前`;
}

function WorkbenchInner() {
  const qc = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const isFde = isFdeRole(user?.role);

  const agentFromUrl = searchParams.get('agent');
  const convFromUrl = searchParams.get('conversation');
  const modeFromUrl = searchParams.get('mode');

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(agentFromUrl);
  const [activeConvId, setActiveConvId] = useState<string | null>(convFromUrl);
  const [mode, setMode] = useState<WorkbenchMode>(modeFromUrl === 'teach' ? 'teach' : 'work');
  /** Agent Builder surface — independent of selecting an existing Agent. */
  const [builderOpen, setBuilderOpen] = useState(modeFromUrl === 'builder');
  /** Live builder session for right-rail checklist (no technical settings). */
  const [builderSession, setBuilderSession] = useState<BuilderSession | null>(null);
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [sentRunIds, setSentRunIds] = useState<Record<string, string>>({});
  const [runSteps, setRunSteps] = useState<Record<string, RunStep[]>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  // Teach-mode local transcript (not persisted server-side in Phase 1).
  const [teachMessages, setTeachMessages] = useState<TeachChatMsg[]>([
    {
      id: 'welcome',
      kind: 'system',
      text: '用文字或語音描述要教的流程，或按「有哪些流程？」。也可開始錄製桌面操作。技能不會自動確認。',
    },
  ]);
  const [draftSkillId, setDraftSkillId] = useState<string | null>(null);
  const [teachSending, setTeachSending] = useState(false);
  const [teachError, setTeachError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [proposingId, setProposingId] = useState<string | null>(null);
  const [recordingWanted, setRecordingWanted] = useState(false);
  const [recBusy, setRecBusy] = useState(false);
  const [recordingConsentOpen, setRecordingConsentOpen] = useState(false);
  const [recordingHint, setRecordingHint] = useState('');
  const [recordingAgentId, setRecordingAgentId] = useState<string | null>(null);
  /** Local dismiss for INTERRUPTED recovery banner (do not auto-resume). */
  const [interruptedDismissed, setInterruptedDismissed] = useState(false);
  const teachEndRef = useRef<HTMLDivElement | null>(null);

  // Keep URL query in sync for deep links (agent + conversation + mode).
  const syncUrl = useCallback(
    (next: {
      agent?: string | null;
      conversation?: string | null;
      mode?: WorkbenchMode;
      builder?: boolean;
    }) => {
      const params = new URLSearchParams();
      const a = next.agent !== undefined ? next.agent : selectedAgentId;
      const c = next.conversation !== undefined ? next.conversation : activeConvId;
      const m = next.mode !== undefined ? next.mode : mode;
      const b = next.builder !== undefined ? next.builder : builderOpen;
      if (b) {
        params.set('mode', 'builder');
      } else {
        if (a) params.set('agent', a);
        if (c) params.set('conversation', c);
        if (m === 'teach') params.set('mode', 'teach');
      }
      const qs = params.toString();
      const nextPath = qs ? `/work?${qs}` : '/work';
      // Avoid redundant replace loops when URL already matches.
      const cur = typeof window !== 'undefined' ? `${window.location.pathname}${window.location.search}` : '';
      if (cur === nextPath) return;
      router.replace(nextPath, { scroll: false });
    },
    [selectedAgentId, activeConvId, mode, builderOpen, router],
  );

  const agentsQ = useQuery({
    queryKey: ['agents'],
    queryFn: () => API.get<AgentListItem[]>('/api/agents'),
  });

  // Validate agent id against loaded list; fall back + rewrite canonical query.
  useEffect(() => {
    const list = agentsQ.data;
    if (!list) return;
    if (list.length === 0) {
      if (selectedAgentId !== null) {
        setSelectedAgentId(null);
        setActiveConvId(null);
        syncUrl({ agent: null, conversation: null });
      }
      return;
    }
    const valid = selectedAgentId && list.some((a) => a.id === selectedAgentId);
    if (!valid) {
      const id = list[0]!.id;
      setSelectedAgentId(id);
      setActiveConvId(null);
      setSentRunIds({});
      setRunSteps({});
      syncUrl({ agent: id, conversation: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentsQ.data, selectedAgentId]);

  const agentDetailQ = useQuery({
    queryKey: ['agent', selectedAgentId],
    queryFn: () => API.get<AgentDetail>(`/api/agents/${selectedAgentId}`),
    enabled: !!selectedAgentId,
  });

  const conversationsQ = useQuery({
    queryKey: ['conversations', selectedAgentId],
    queryFn: () => API.get<Conversation[]>(`/api/agents/${selectedAgentId}/conversations`),
    enabled: !!selectedAgentId,
  });

  // Validate conversation id against loaded (owner-scoped) list; fall back + rewrite URL.
  useEffect(() => {
    if (!selectedAgentId || !conversationsQ.data) return;
    const list = conversationsQ.data;
    if (activeConvId && list.some((c) => c.id === activeConvId)) {
      // Keep query canonical once both sides agree.
      if (searchParams.get('agent') !== selectedAgentId || searchParams.get('conversation') !== activeConvId) {
        syncUrl({ agent: selectedAgentId, conversation: activeConvId });
      }
      return;
    }
    if (list.length > 0) {
      const id = list[0]!.id;
      setActiveConvId(id);
      syncUrl({ agent: selectedAgentId, conversation: id });
    } else {
      setActiveConvId(null);
      syncUrl({ agent: selectedAgentId, conversation: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAgentId, conversationsQ.data]);

  const messagesQ = useQuery({
    queryKey: ['messages', activeConvId],
    queryFn: () => API.get<ChatMessage[]>(`/api/conversations/${activeConvId}/messages`),
    enabled: !!activeConvId && mode === 'work',
  });

  const createConvMutation = useMutation({
    mutationFn: (title?: string) =>
      API.post<Conversation>(`/api/agents/${selectedAgentId}/conversations`, title ? { title } : {}),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['conversations', selectedAgentId] });
      setActiveConvId(data.id);
      setSendError(null);
      syncUrl({ conversation: data.id });
    },
    onError: (e) => {
      setSendError(e instanceof Error ? e.message : String(e));
    },
  });

  const sendMutation = useMutation({
    mutationFn: (content: string) =>
      API.post<{ messageId: string; runId: string }>(`/api/conversations/${activeConvId}/messages`, {
        content,
      }),
    onSuccess: (data) => {
      setSentRunIds((prev) => ({ ...prev, [data.messageId]: data.runId }));
      setDraft('');
      setSendError(null);
      void qc.invalidateQueries({ queryKey: ['messages', activeConvId] });
      void qc.invalidateQueries({ queryKey: ['conversations', selectedAgentId] });
    },
    onError: (e) => {
      setSendError(e instanceof Error ? e.message : String(e));
    },
  });

  const recStatusQ = useQuery({
    queryKey: ['recording-status'],
    queryFn: () => API.get<RecordingStatus>('/api/recording/status'),
    refetchInterval: (q) => {
      const active = recordingWanted || isRecordingActive(q.state.data);
      return active ? 3000 : false;
    },
    retry: false,
    enabled: mode === 'teach',
  });
  const recordingOn = recordingWanted || isRecordingActive(recStatusQ.data);
  const recSessionStatus = recordingSessionStatus(recStatusQ.data);

  // Never treat INTERRUPTED / FAILED / terminal sessions as an active recording
  // after restart or poll — do not auto-resume; keep record button available.
  useEffect(() => {
    if (!recSessionStatus) return;
    if (recSessionStatus !== 'RECORDING') {
      setRecordingWanted(false);
    } else if (recStatusQ.data?.session?.agentId) {
      setRecordingAgentId(recStatusQ.data.session.agentId);
    }
    if (recSessionStatus !== 'INTERRUPTED') {
      setInterruptedDismissed(false);
    }
  }, [recSessionStatus, recStatusQ.data?.session?.agentId]);

  // WS: chat replies + run steps; only refresh current conversation.
  // Backend `run.step` payload uses `phase` (not `status`).
  const handleFrame = useCallback(
    (frame: AwpFrame) => {
      const topic = frame.topic ?? '';
      const payload = (frame.payload ?? {}) as {
        runId?: string;
        stepKey?: string;
        round?: number;
        phase?: string;
        status?: string;
        verdict?: string;
        conversationId?: string;
        skillId?: string;
        sessionId?: string;
        type?: string;
      };

      const isRunEvent = topic.startsWith('run.') || topic === 'run.step' || payload?.type === 'run.step';
      if (isRunEvent && payload?.runId) {
        const { runId, stepKey, round, phase, status, verdict } = payload;
        // Prefer phase; tolerate legacy status if ever present.
        const stepPhase = phase ?? status;
        if (stepKey && stepPhase) {
          setRunSteps((prev) => {
            const list = prev[runId!] ? [...prev[runId!]] : [];
            const idx = list.findIndex((s) => s.stepKey === stepKey && s.round === round);
            const next: RunStep = { stepKey, round, phase: stepPhase, verdict };
            if (idx >= 0) list[idx] = next;
            else list.push(next);
            return { ...prev, [runId!]: list };
          });
        }
        if (topic === 'run.finished' && activeConvId) {
          void qc.invalidateQueries({ queryKey: ['messages', activeConvId] });
        }
      }

      const isChatEvent =
        topic === 'chat.message' && (!activeConvId || payload?.conversationId === activeConvId);
      if (isChatEvent && activeConvId) {
        void qc.invalidateQueries({ queryKey: ['messages', activeConvId] });
      }

      if (topic === 'skill.review_ready' && payload.skillId && selectedAgentId) {
        void qc.invalidateQueries({ queryKey: ['agent', selectedAgentId] });
      }

      if (topic === 'recording.progress') {
        void recStatusQ.refetch();
        if (payload.skillId && selectedAgentId) {
          void qc.invalidateQueries({ queryKey: ['agent', selectedAgentId] });
        }
      }
    },
    [activeConvId, selectedAgentId, qc, recStatusQ.refetch],
  );

  const topics = useMemo(() => ['run.*', 'chat.*', 'skill.review_ready', 'recording.progress'], []);
  useAwp(topics, handleFrame);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messagesQ.data, runSteps]);

  useEffect(() => {
    teachEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [teachMessages, teachSending]);

  // Reset teach draft chain when agent changes.
  useEffect(() => {
    setDraftSkillId(null);
    setTeachError(null);
    setTeachMessages([
      {
        id: 'welcome',
        kind: 'system',
        text: '用文字或語音描述要教的流程，或按「有哪些流程？」。也可開始錄製桌面操作。技能不會自動確認。',
      },
    ]);
  }, [selectedAgentId]);

  function selectAgent(id: string) {
    // Selecting an Agent exits builder mode (workbench returns to work/teach).
    setBuilderOpen(false);
    setBuilderSession(null);
    setSelectedAgentId(id);
    setActiveConvId(null);
    setSentRunIds({});
    setRunSteps({});
    setSendError(null);
    setDraft('');
    syncUrl({ agent: id, conversation: null, builder: false });
  }

  function selectConversation(id: string) {
    setBuilderOpen(false);
    setBuilderSession(null);
    setActiveConvId(id);
    setSendError(null);
    setMode('work');
    syncUrl({ conversation: id, builder: false, mode: 'work' });
  }

  function switchMode(next: WorkbenchMode) {
    setMode(next);
    setBuilderOpen(false);
    setBuilderSession(null);
    setSendError(null);
    setTeachError(null);
    syncUrl({ mode: next, builder: false });
  }

  function openBuilder() {
    setBuilderOpen(true);
    setSendError(null);
    setTeachError(null);
    syncUrl({ builder: true });
  }

  function closeBuilder() {
    setBuilderOpen(false);
    setBuilderSession(null);
    syncUrl({ builder: false, mode });
  }

  function submitWork(e: React.FormEvent) {
    e.preventDefault();
    const content = draft.trim();
    if (!content || !activeConvId || sendMutation.isPending) return;
    sendMutation.mutate(content);
  }

  async function ensureConversationThenSend() {
    const content = draft.trim();
    if (!content || !selectedAgentId) return;
    if (activeConvId) {
      sendMutation.mutate(content);
      return;
    }
    try {
      const title = content.length > 40 ? `${content.slice(0, 40)}…` : content;
      const conv = await API.post<Conversation>(`/api/agents/${selectedAgentId}/conversations`, {
        title,
      });
      void qc.invalidateQueries({ queryKey: ['conversations', selectedAgentId] });
      setActiveConvId(conv.id);
      syncUrl({ conversation: conv.id });
      const data = await API.post<{ messageId: string; runId: string }>(
        `/api/conversations/${conv.id}/messages`,
        { content },
      );
      setSentRunIds((prev) => ({ ...prev, [data.messageId]: data.runId }));
      setDraft('');
      setSendError(null);
      void qc.invalidateQueries({ queryKey: ['messages', conv.id] });
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    }
  }

  function pushTeach(msg: TeachChatMsg) {
    setTeachMessages((prev) => [...prev, msg]);
  }

  function isFlowsIntent(text: string): boolean {
    return /有哪些流程|目前有哪些流程|流程清單|list\s*flows/i.test(text.trim());
  }

  async function loadFlows() {
    if (!selectedAgentId) return;
    setTeachSending(true);
    setTeachError(null);
    pushTeach({ id: crypto.randomUUID(), kind: 'user', text: '有哪些流程？' });
    try {
      const flows = await API.get<AgentFlows>(`/api/agents/${selectedAgentId}/flows`);
      pushTeach({
        id: crypto.randomUUID(),
        kind: 'flows',
        skills: flows.skills ?? [],
        workflows: flows.workflows ?? [],
      });
    } catch (e) {
      pushTeach({
        id: crypto.randomUUID(),
        kind: 'error',
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTeachSending(false);
    }
  }

  async function sendTrainMessage(raw: string) {
    if (!selectedAgentId) return;
    const message = raw.trim();
    if (!message || teachSending) return;
    if (isFlowsIntent(message)) {
      setDraft('');
      await loadFlows();
      return;
    }

    setTeachSending(true);
    setTeachError(null);
    setDraft('');
    pushTeach({ id: crypto.randomUUID(), kind: 'user', text: message });
    const draftingId = crypto.randomUUID();
    pushTeach({ id: draftingId, kind: 'drafting' });

    try {
      const requestDraft = () =>
        API.post<TrainMessageResult>(`/api/agents/${selectedAgentId}/train/message`, {
          message,
          skillId: draftSkillId ?? undefined,
        });
      let result: TrainMessageResult;
      try {
        result = await requestDraft();
      } catch (e) {
        // Cloud/tunnel proxies can occasionally lose a completed JSON response.
        // The server deduplicates the identical retry, so this cannot create a
        // second skill after the first mutation already committed.
        if (!(e instanceof ApiError) || e.code !== 'PARSE') throw e;
        await new Promise((resolve) => window.setTimeout(resolve, 3000));
        result = await requestDraft();
      }
      const understanding = normalizeUnderstanding(result.understanding);
      let name = parseSkillNameFromMd(result.contentMd ?? '');
      try {
        const detail = await API.get<SkillDetail>(`/api/skills/${result.skillId}`);
        if (detail.name) name = detail.name;
      } catch {
        /* md name is fine */
      }
      setDraftSkillId(result.skillId);
      setTeachMessages((prev) =>
        prev
          .filter((m) => m.id !== draftingId)
          .concat({
            id: crypto.randomUUID(),
            kind: 'draft',
            skillId: result.skillId,
            name,
            reviewStatus: result.reviewStatus,
            understanding,
          }),
      );
      void qc.invalidateQueries({ queryKey: ['agent', selectedAgentId] });
    } catch (e) {
      setTeachMessages((prev) =>
        prev
          .filter((m) => m.id !== draftingId)
          .concat({
            id: crypto.randomUUID(),
            kind: 'error',
            text: e instanceof Error ? e.message : String(e),
          }),
      );
    } finally {
      setTeachSending(false);
    }
  }

  async function confirmSkill(skillId: string) {
    if (!selectedAgentId || !isFde) return;
    setConfirmingId(skillId);
    setTeachError(null);
    try {
      await API.post(`/api/skills/${skillId}/confirm`);
      // Attach is idempotent when already pre-linked; only ignore exact duplicate CONFLICT.
      // CODEX / other errors must surface — never claim attached after a real failure.
      try {
        await API.post(`/api/agents/${selectedAgentId}/skills`, { skillId });
      } catch (e) {
        if (e instanceof ApiError && e.code === 'CONFLICT') {
          // e.g. race on unique agentId+skillId — treat as already linked
        } else {
          throw e;
        }
      }
      setTeachMessages((prev) =>
        prev.map((m) =>
          m.kind === 'draft' && m.skillId === skillId
            ? { ...m, reviewStatus: 'CONFIRMED', statusNote: '已確認並掛載' }
            : m,
        ),
      );
      setDraftSkillId(null);
      void qc.invalidateQueries({ queryKey: ['agent', selectedAgentId] });
    } catch (e) {
      setTeachError(e instanceof Error ? e.message : String(e));
    } finally {
      setConfirmingId(null);
    }
  }

  async function proposeSkill(skillId: string, name: string) {
    if (!selectedAgentId) return;
    setProposingId(skillId);
    setTeachError(null);
    try {
      await API.post(`/api/agents/${selectedAgentId}/proposals`, {
        targetType: 'SKILL',
        targetId: skillId,
        proposedChange: {
          action: 'confirm_skill',
          skillId,
          name,
          note: '操作者從工作台訓練模式送出：請 FDE 確認並掛載此技能草稿',
        },
        severity: 'medium',
      });
      setTeachMessages((prev) =>
        prev.map((m) =>
          m.kind === 'draft' && m.skillId === skillId
            ? { ...m, statusNote: '已送出提案，等待 FDE 審核' }
            : m,
        ),
      );
    } catch (e) {
      setTeachError(e instanceof Error ? e.message : String(e));
    } finally {
      setProposingId(null);
    }
  }

  async function startRecording() {
    setRecBusy(true);
    setTeachError(null);
    setRecordingConsentOpen(false);
    try {
      if (!selectedAgentId) throw new Error('請先選擇要訓練的 Agent');
      const started = await API.post<{ agentId: string }>('/api/recording/start', {
        agentId: selectedAgentId,
      });
      setRecordingWanted(true);
      setRecordingAgentId(started.agentId);
      pushTeach({
        id: crypto.randomUUID(),
        kind: 'system',
        text: '已開始錄製。請在桌面完成一次操作後按「結束錄製」。單次上限 30 分鐘。',
      });
      void recStatusQ.refetch();
    } catch (e) {
      // Surface real API errors — never fake success (Computer Use may timeout).
      setTeachError(e instanceof Error ? e.message : String(e));
    } finally {
      setRecBusy(false);
    }
  }

  async function stopRecordingAndImport() {
    const targetAgentId = recordingAgentId ?? recStatusQ.data?.session?.agentId ?? selectedAgentId;
    if (!targetAgentId) return;
    setRecBusy(true);
    setTeachError(null);
    try {
      const stopped = await API.post<{ sessionId: string }>('/api/recording/stop');
      setRecordingWanted(false);
      pushTeach({ id: crypto.randomUUID(), kind: 'system', text: '錄製已停止，正在匯入為技能草稿…' });
      const draftingId = crypto.randomUUID();
      pushTeach({ id: draftingId, kind: 'drafting' });
      const result = await API.post<{
        skillId?: string;
        id?: string;
        name?: string;
        reviewStatus?: string;
        understanding?: unknown;
        contentMd?: string;
      }>(`/api/agents/${targetAgentId}/recording/to-skill`, {
        sessionId: stopped.sessionId,
        hint: recordingHint.trim() || undefined,
      });
      const skillId = result.skillId ?? result.id;
      if (!skillId) throw new Error('recording/to-skill 未回傳 skillId');
      let name = result.name ?? parseSkillNameFromMd(result.contentMd ?? '');
      let understanding = normalizeUnderstanding(result.understanding);
      let reviewStatus = result.reviewStatus ?? 'AWAITING_USER_CONFIRM';
      try {
        const detail = await API.get<SkillDetail>(`/api/skills/${skillId}`);
        name = detail.name || name;
        understanding = detail.understanding ?? understanding;
        reviewStatus = detail.reviewStatus || reviewStatus;
      } catch {
        /* use payload */
      }
      setDraftSkillId(skillId);
      setTeachMessages((prev) =>
        prev
          .filter((m) => m.id !== draftingId)
          .concat({
            id: crypto.randomUUID(),
            kind: 'draft',
            skillId,
            name: name || '錄製技能草稿',
            reviewStatus,
            understanding,
          }),
      );
      void qc.invalidateQueries({ queryKey: ['agent', targetAgentId] });
      void recStatusQ.refetch();
      setRecordingHint('');
      setRecordingAgentId(null);
    } catch (e) {
      setRecordingWanted(false);
      pushTeach({
        id: crypto.randomUUID(),
        kind: 'error',
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setRecBusy(false);
    }
  }

  const agents = agentsQ.data ?? [];
  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null;
  const agentDetail = agentDetailQ.data;
  const conversations = conversationsQ.data ?? [];
  const messages = messagesQ.data ?? [];
  const busyWork = sendMutation.isPending || createConvMutation.isPending;

  return (
    <AppShell>
      <div className="flex h-full min-h-0">
        {/* Left: agents + threads */}
        <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-panel/50">
          <div className="space-y-2 border-b border-border p-3">
            <button
              type="button"
              className="btn-primary w-full justify-center"
              aria-pressed={builderOpen}
              onClick={() => openBuilder()}
            >
              <Sparkles className="h-4 w-4" />
              建立 AI 員工
            </button>
            <button
              type="button"
              className="btn-ghost w-full justify-center border border-border"
              disabled={!selectedAgentId || createConvMutation.isPending}
              onClick={() => {
                // New task exits builder and starts a work thread on the selected Agent.
                setBuilderOpen(false);
                setBuilderSession(null);
                setMode('work');
                createConvMutation.mutate(undefined);
                syncUrl({ builder: false, mode: 'work', agent: selectedAgentId });
              }}
            >
              {createConvMutation.isPending ? (
                <Spinner className="border-white/40 border-t-white" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              新任務
            </button>
          </div>

          <div className="border-b border-border px-3 py-2">
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
              Agents
            </div>
            {agentsQ.isLoading && (
              <div className="flex justify-center py-4">
                <Spinner className="h-4 w-4" />
              </div>
            )}
            {agentsQ.isError && (
              <p className="px-1 text-xs text-rose-400">
                {agentsQ.error instanceof Error ? agentsQ.error.message : '無法載入員工清單'}
              </p>
            )}
            {!agentsQ.isLoading && agents.length === 0 && (
              <p className="px-1 text-xs text-muted">尚無 Agent。請 FDE 在管理中心建立員工。</p>
            )}
            <div className="max-h-40 space-y-0.5 overflow-y-auto">
              {agents.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => selectAgent(a.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm',
                    selectedAgentId === a.id
                      ? 'bg-brand/10 font-medium text-brand'
                      : 'text-muted hover:bg-black/5 dark:hover:bg-white/5',
                  )}
                >
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-brand/10 text-sm">
                    {a.avatar || <Bot className="h-3.5 w-3.5 text-brand" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col px-3 py-2">
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
              任務 Threads
            </div>
            {!selectedAgentId && (
              <p className="px-1 text-xs text-muted">先選一位 Agent</p>
            )}
            {selectedAgentId && conversationsQ.isLoading && (
              <div className="flex justify-center py-4">
                <Spinner className="h-4 w-4" />
              </div>
            )}
            {selectedAgentId && conversationsQ.isError && (
              <p className="px-1 text-xs text-rose-400">
                {conversationsQ.error instanceof Error
                  ? conversationsQ.error.message
                  : '無法載入任務'}
              </p>
            )}
            <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
              {conversations.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => selectConversation(c.id)}
                  className={cn(
                    'block w-full truncate rounded-lg px-2 py-2 text-left text-sm',
                    activeConvId === c.id
                      ? 'bg-brand/10 font-medium text-brand'
                      : 'text-muted hover:bg-black/5 dark:hover:bg-white/5',
                  )}
                >
                  <div className="truncate">{c.title || `任務 ${c.id.slice(0, 8)}`}</div>
                  {c.createdAt && (
                    <div className="text-[10px] opacity-70">{relativeTime(c.createdAt)}</div>
                  )}
                </button>
              ))}
              {selectedAgentId && !conversationsQ.isLoading && conversations.length === 0 && (
                <p className="px-1 text-xs text-muted">尚無任務，按「新任務」開始</p>
              )}
            </div>
          </div>
        </aside>

        {/* Center: thread + composer OR Agent Builder */}
        <section className="flex min-w-0 flex-1 flex-col">
          {builderOpen ? (
            <AgentBuilderPanel
              onClose={() => closeBuilder()}
              onSessionChange={setBuilderSession}
              onActivated={(agentId) => {
                void qc.invalidateQueries({ queryKey: ['agents'] });
                if (agentId) {
                  void qc.invalidateQueries({ queryKey: ['agent', agentId] });
                  setSelectedAgentId(agentId);
                  setBuilderOpen(false);
                  setBuilderSession(null);
                  setMode('work');
                  setActiveConvId(null);
                  syncUrl({ agent: agentId, conversation: null, builder: false, mode: 'work' });
                }
              }}
            />
          ) : (
            <>
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">
                {selectedAgent?.name ?? '選擇 Agent'}
              </div>
              <div className="truncate text-xs text-muted">
                {mode === 'work'
                  ? activeConvId
                    ? conversations.find((c) => c.id === activeConvId)?.title ||
                      `任務 ${activeConvId.slice(0, 8)}`
                    : '交代工作'
                  : '教它新工作'}
              </div>
            </div>
            <div className="flex shrink-0 rounded-lg border border-border p-0.5">
              <button
                type="button"
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  mode === 'work' ? 'bg-brand/15 text-brand' : 'text-muted hover:text-fg',
                )}
                onClick={() => switchMode('work')}
              >
                <MessageSquare className="h-3.5 w-3.5" />
                交代工作
              </button>
              <button
                type="button"
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  mode === 'teach' ? 'bg-brand/15 text-brand' : 'text-muted hover:text-fg',
                )}
                onClick={() => switchMode('teach')}
              >
                <GraduationCap className="h-3.5 w-3.5" />
                教它新工作
              </button>
            </div>
          </div>

          {mode === 'work' ? (
            <>
              <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
                {!selectedAgentId && (
                  <div className="flex h-full items-center justify-center">
                    <EmptyState
                      title="歡迎使用 AI 工作台"
                      hint="從左側選一位 Agent，建立任務後用日常語言交代工作。"
                    />
                  </div>
                )}
                {selectedAgentId && !activeConvId && (
                  <div className="flex h-full items-center justify-center">
                    <EmptyState
                      title="尚無任務 thread"
                      hint="按左上「新任務」，或直接在下方輸入，系統會自動建立。"
                    />
                  </div>
                )}
                {selectedAgentId && activeConvId && messagesQ.isLoading && (
                  <div className="flex justify-center py-12">
                    <Spinner className="h-5 w-5" />
                  </div>
                )}
                {selectedAgentId && activeConvId && messagesQ.isError && (
                  <p className="text-center text-sm text-rose-400">
                    {messagesQ.error instanceof Error
                      ? messagesQ.error.message
                      : '無法載入訊息'}
                  </p>
                )}
                {selectedAgentId && activeConvId && !messagesQ.isLoading && messages.length === 0 && (
                  <p className="text-center text-sm text-muted">
                    尚無訊息。直接告訴 {selectedAgent?.name ?? '這位員工'} 要做什麼。
                  </p>
                )}
                {messages.map((m) => {
                  const role = (m.role ?? m.sender ?? 'user').toString().toUpperCase();
                  const isUser = role.includes('USER');
                  const runId = m.runId ?? sentRunIds[m.id];
                  return (
                    <div
                      key={m.id}
                      className={cn('flex flex-col gap-1.5', isUser ? 'items-end' : 'items-start')}
                    >
                      <div
                        className={cn(
                          'max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm',
                          isUser ? 'bg-brand text-white' : 'bg-black/5 dark:bg-white/10',
                        )}
                      >
                        {m.content}
                      </div>
                      {isUser && runId && <ChatRunTimeline steps={runSteps[runId] ?? []} />}
                    </div>
                  );
                })}
              </div>

              <div className="border-t border-border p-3">
                {sendError && <p className="mb-2 text-sm text-rose-400">{sendError}</p>}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (activeConvId) submitWork(e);
                    else void ensureConversationThenSend();
                  }}
                  className="flex items-end gap-2"
                >
                  <textarea
                    className="input min-h-[44px] max-h-32 flex-1 resize-y"
                    placeholder={
                      selectedAgentId
                        ? `告訴 ${selectedAgent?.name ?? 'Agent'} 要做什麼…`
                        : '請先選擇 Agent'
                    }
                    value={draft}
                    rows={2}
                    disabled={!selectedAgentId || busyWork}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        if (!draft.trim() || !selectedAgentId || busyWork) return;
                        if (activeConvId) sendMutation.mutate(draft.trim());
                        else void ensureConversationThenSend();
                      }
                    }}
                  />
                  <button
                    type="submit"
                    className="btn-primary h-9 shrink-0"
                    disabled={!draft.trim() || !selectedAgentId || busyWork}
                  >
                    {busyWork ? (
                      <Spinner className="border-white/40 border-t-white" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                  </button>
                </form>
              </div>
            </>
          ) : (
            <>
              {/* Teach mode */}
              <div className="border-b border-border px-4 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs text-muted">
                    讓 AI 看你操作一次，完成後會產生待審核的技能草稿
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="btn-ghost text-xs"
                      disabled={!selectedAgentId || teachSending}
                      onClick={() => void loadFlows()}
                    >
                      <List className="h-3.5 w-3.5" /> 有哪些流程？
                    </button>
                    {!recordingOn ? (
                      <button
                        type="button"
                        className="btn-primary text-xs"
                        disabled={!selectedAgentId || recBusy || teachSending}
                        onClick={() => setRecordingConsentOpen(true)}
                      >
                        {recBusy ? (
                          <Spinner className="border-white/40 border-t-white" />
                        ) : (
                          <Video className="h-3.5 w-3.5" />
                        )}
                        錄製操作示範
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn-primary bg-rose-600 text-xs hover:bg-rose-500"
                        disabled={recBusy}
                        onClick={() => void stopRecordingAndImport()}
                      >
                        {recBusy ? (
                          <Spinner className="border-white/40 border-t-white" />
                        ) : (
                          <Square className="h-3 w-3" />
                        )}
                        結束錄製
                      </button>
                    )}
                  </div>
                </div>
                {recordingConsentOpen && !recordingOn && (
                  <div className="mt-3 rounded-xl border border-brand/35 bg-brand/10 p-3 text-sm">
                    <div className="font-semibold">開始錄製前，先確認這次要教什麼</div>
                    <p className="mt-1 text-xs leading-5 text-muted">
                      系統會擷取這台電腦上的畫面與操作事件。請先關閉含密碼、驗證碼、個資或帳號資訊的視窗；完成後只會建立技能草稿，仍需 FDE 審核才會生效。
                    </p>
                    <textarea
                      className="input mt-3 min-h-[72px] w-full resize-y text-sm"
                      value={recordingHint}
                      onChange={(e) => setRecordingHint(e.target.value)}
                      placeholder="例如：示範如何打開 LINE、進入指定群組、整理今天的訊息；群組名稱與日期要成為每次可更換的輸入。"
                      maxLength={4000}
                      autoFocus
                    />
                    <div className="mt-3 flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        className="btn-ghost text-xs"
                        disabled={recBusy}
                        onClick={() => setRecordingConsentOpen(false)}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="btn-primary text-xs"
                        disabled={recBusy || !selectedAgentId}
                        onClick={() => void startRecording()}
                      >
                        {recBusy ? <Spinner className="border-white/40 border-t-white" /> : <Circle className="h-3 w-3 fill-rose-500 text-rose-500" />}
                        我準備好了，開始錄製
                      </button>
                    </div>
                  </div>
                )}
                {recordingOn && (
                  <div className="mt-2 flex items-center gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-300">
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500" />
                    </span>
                    正在錄製這台電腦的操作 — 單次上限 30 分鐘
                  </div>
                )}
                {recSessionStatus === 'INTERRUPTED' && !interruptedDismissed && (
                  <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200">
                    <span>上次錄製因伺服器重啟而中斷，請重新開始錄製。</span>
                    <button
                      type="button"
                      className="shrink-0 rounded px-1.5 py-0.5 text-amber-100/90 underline-offset-2 hover:underline"
                      onClick={() => {
                        setInterruptedDismissed(true);
                        void recStatusQ.refetch();
                      }}
                    >
                      知道了
                    </button>
                  </div>
                )}
                {recSessionStatus === 'COMPILING' && (
                  <div className="mt-2 rounded-md border border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-xs text-sky-200">
                    正在把錄製編譯為技能草稿…
                  </div>
                )}
                {recSessionStatus === 'FAILED' && (
                  <div className="mt-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-300">
                    錄製編譯失敗，請重試。
                  </div>
                )}
              </div>

              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
                {!selectedAgentId && (
                  <EmptyState title="先選一位 Agent" hint="再開始教它新工作" />
                )}
                {teachMessages.map((m) => {
                  if (m.kind === 'user') {
                    return (
                      <div key={m.id} className="flex justify-end">
                        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand/20 px-3 py-2 text-sm">
                          {m.text}
                        </div>
                      </div>
                    );
                  }
                  if (m.kind === 'system') {
                    return (
                      <div key={m.id} className="text-center text-xs text-muted">
                        {m.text}
                      </div>
                    );
                  }
                  if (m.kind === 'drafting') {
                    return (
                      <div key={m.id} className="flex items-center gap-2 text-sm text-muted">
                        <Spinner className="h-4 w-4" /> 草擬中…
                      </div>
                    );
                  }
                  if (m.kind === 'error') {
                    return (
                      <div
                        key={m.id}
                        className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300"
                      >
                        {m.text}
                      </div>
                    );
                  }
                  if (m.kind === 'flows') {
                    return (
                      <div key={m.id} className="card space-y-3 border-border/80 bg-black/10 p-4">
                        <div className="text-sm font-medium">目前流程清單（免 LLM）</div>
                        <div>
                          <div className="mb-1 text-xs font-medium text-muted">技能</div>
                          {m.skills.length === 0 ? (
                            <p className="text-sm text-muted">尚無掛載技能</p>
                          ) : (
                            <ul className="space-y-2">
                              {m.skills.map((s) => (
                                <li
                                  key={s.id}
                                  className="flex items-start justify-between gap-2 text-sm"
                                >
                                  <div className="min-w-0">
                                    <div className="font-medium">{s.name}</div>
                                    {s.summary && (
                                      <div className="text-xs text-muted">{s.summary}</div>
                                    )}
                                  </div>
                                  <StatusBadge status={s.reviewStatus} />
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                        <div>
                          <div className="mb-1 text-xs font-medium text-muted">工作流</div>
                          {m.workflows.length === 0 ? (
                            <p className="text-sm text-muted">尚無工作流</p>
                          ) : (
                            <ul className="space-y-2">
                              {m.workflows.map((w) => (
                                <li
                                  key={w.id}
                                  className="flex items-center justify-between gap-2 text-sm"
                                >
                                  <span className="font-medium">{w.name}</span>
                                  <span className="badge bg-black/10 text-muted dark:bg-white/10">
                                    {w.trigger}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                    );
                  }
                  return (
                    <SkillDraftCard
                      key={m.id}
                      skillId={m.skillId}
                      name={m.name}
                      reviewStatus={m.reviewStatus}
                      understanding={m.understanding}
                      statusNote={m.statusNote}
                      isFde={isFde}
                      confirming={confirmingId === m.skillId}
                      proposing={proposingId === m.skillId}
                      onConfirm={(id) => void confirmSkill(id)}
                      onPropose={(id, name) => void proposeSkill(id, name)}
                    />
                  );
                })}
                <div ref={teachEndRef} />
              </div>

              <div className="border-t border-border px-3 py-3">
                {teachError && <p className="mb-2 text-sm text-rose-400">{teachError}</p>}
                <div className="flex items-end gap-2">
                  <textarea
                    className="input min-h-[44px] max-h-32 flex-1 resize-y"
                    placeholder={
                      selectedAgentId
                        ? '描述要教的流程，或問「有哪些流程？」…'
                        : '請先選擇 Agent'
                    }
                    value={draft}
                    rows={2}
                    disabled={!selectedAgentId || teachSending}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void sendTrainMessage(draft);
                      }
                    }}
                  />
                  <VoiceInput
                    disabled={!selectedAgentId || teachSending}
                    onTranscript={(text) => {
                      setDraft((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
                    }}
                  />
                  <button
                    type="button"
                    className="btn-primary h-9 shrink-0"
                    disabled={!draft.trim() || !selectedAgentId || teachSending}
                    onClick={() => void sendTrainMessage(draft)}
                  >
                    {teachSending ? (
                      <Spinner className="border-white/40 border-t-white" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                    送出
                  </button>
                </div>
                {!isFde && (
                  <p className="mt-2 text-[11px] text-muted">
                    你是操作者：技能草稿只能送出提案，由 FDE 確認後才會掛載。
                  </p>
                )}
              </div>
            </>
          )}
            </>
          )}
        </section>

        {/* Right: builder checklist OR agent summary + tips */}
        <aside className="hidden w-72 shrink-0 flex-col border-l border-border bg-panel/30 lg:flex">
          {builderOpen ? (
            <AgentBuilderRail session={builderSession} />
          ) : (
            <>
              <div className="border-b border-border p-4">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
                  Agent 摘要
                </div>
                {agentDetailQ.isLoading && selectedAgentId && (
                  <div className="mt-4 flex justify-center">
                    <Spinner className="h-4 w-4" />
                  </div>
                )}
                {!selectedAgentId && (
                  <p className="mt-2 text-sm text-muted">選一位 Agent 查看能力摘要</p>
                )}
                {agentDetail && (
                  <div className="mt-3 space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand/10 text-lg">
                        {agentDetail.avatar || <Bot className="h-5 w-5 text-brand" />}
                      </span>
                      <div className="min-w-0">
                        <div className="truncate font-medium">{agentDetail.name}</div>
                        <StatusBadge status={agentDetail.status} />
                      </div>
                    </div>
                    <p className="line-clamp-4 text-sm text-muted">
                      {agentDetail.description || '尚無描述'}
                    </p>
                    {agentDetail.department && (
                      <div className="text-xs text-muted">部門 · {agentDetail.department}</div>
                    )}
                  </div>
                )}
              </div>

              <div className="border-b border-border p-4">
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                  <Wrench className="h-3 w-3" /> 已掛載技能
                </div>
                {!agentDetail && <p className="text-xs text-muted">—</p>}
                {agentDetail && agentDetail.skills.length === 0 && (
                  <p className="text-xs text-muted">尚未掛載技能。可切換「教它新工作」。</p>
                )}
                {agentDetail && agentDetail.skills.length > 0 && (
                  <ul className="max-h-40 space-y-1.5 overflow-y-auto">
                    {agentDetail.skills.map((s) => (
                      <li
                        key={s.skillId}
                        className="flex items-center justify-between gap-2 text-sm"
                      >
                        <span className="truncate">{s.skill?.name ?? s.skillId}</span>
                        <StatusBadge status={s.skill?.reviewStatus ?? 'UNKNOWN'} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="flex-1 space-y-3 overflow-y-auto p-4 text-xs text-muted">
                <div className="text-[11px] font-medium uppercase tracking-wide">工作台提示</div>
                <ul className="list-disc space-y-1.5 pl-4 leading-relaxed">
                  <li>用「建立 AI 員工」從業務目標訪談、規劃、試跑到啟用。</li>
                  <li>用「交代工作」給既有 Agent 任務；回覆會即時出現。</li>
                  <li>用「教它新工作」口述或錄製流程，產生技能草稿。</li>
                  <li>技能不會自動確認；MEMBER 只能送提案／送交 FDE。</li>
                  <li>不會顯示引擎、工作流編排等技術設定。</li>
                </ul>
                {isFde && (
                  <Link
                    href="/admin"
                    className="btn-ghost mt-2 w-full justify-center border border-border text-xs"
                  >
                    <Shield className="h-3.5 w-3.5" />
                    開啟 FDE 管理中心
                  </Link>
                )}
                {isFde && selectedAgentId && (
                  <Link
                    href={`/employees/${selectedAgentId}`}
                    className="block text-center text-[11px] text-brand hover:underline"
                  >
                    進階設定（員工詳情）
                  </Link>
                )}
              </div>
            </>
          )}
        </aside>
      </div>
    </AppShell>
  );
}

export default function WorkPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center">
          <Spinner className="h-6 w-6" />
        </div>
      }
    >
      <WorkbenchInner />
    </Suspense>
  );
}
