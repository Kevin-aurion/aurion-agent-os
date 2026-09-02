'use client';

/**
 * Agent Builder — CEO-friendly interview UI.
 * Business language only: no engines, manifests, raw JSON, MCP, or A2A protocol terms.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  CheckCircle2,
  Circle,
  Loader2,
  Rocket,
  Send,
  Sparkles,
  Upload,
  FileText,
  UserPlus,
  Users,
  History,
  Save,
  X,
  Download,
} from 'lucide-react';
import { API, downloadToDevice } from '@/lib/api';
import { Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  BUILDER_STARTER_EXAMPLES,
  type BuilderMessageResult,
  type BuilderSession,
  builderStatusLabel,
} from '@/components/workbench/types';

function savedFlowName(flow: BuilderSession): string {
  return flow.plan?.proposedAgentName
    ?? flow.brief?.requestedAgentName
    ?? flow.brief?.objective?.slice(0, 52)
    ?? '未命名 AI 員工';
}

function BuilderThinkingBubble({ elapsedSeconds }: { elapsedSeconds: number }) {
  const activity =
    elapsedSeconds < 5
      ? '正在理解你剛剛提供的資訊'
      : elapsedSeconds < 14
        ? '正在整理需求與前後文'
        : elapsedSeconds < 28
          ? '正在準備最適合的下一個問題'
          : '仍在仔細處理這項需求，複雜情境可能需要多一點時間';

  return (
    <div className="flex justify-start" role="status" aria-live="polite" aria-label="AI 正在思考">
      <div className="max-w-[90%] rounded-2xl rounded-bl-md bg-black/5 px-3 py-2.5 text-sm dark:bg-white/10">
        <div className="flex items-center gap-2 font-medium">
          <Sparkles className="h-4 w-4 text-brand" />
          <span>我正在思考</span>
          <span className="inline-flex items-center gap-1" aria-hidden="true">
            {[0, 1, 2].map((dot) => (
              <span
                key={dot}
                className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand"
                style={{ animationDelay: `${dot * 180}ms` }}
              />
            ))}
          </span>
        </div>
        <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          {activity}
        </div>
      </div>
    </div>
  );
}

export function AgentBuilderPanel(props: {
  onClose: () => void;
  /** Existing employee to resume training in the same durable session. */
  agentId?: string | null;
  /** Fired when session state changes (for right-rail checklist). */
  onSessionChange?: (session: BuilderSession | null) => void;
  /** After direct activation — open the built/reused agent. */
  onActivated?: (agentId: string | null) => void;
}) {
  const builderSessionStorageKey = 'aios.agentBuilderSessionId';
  const [session, setSession] = useState<BuilderSession | null>(null);
  const [view, setView] = useState<'loading' | 'new' | 'starting' | 'session'>('loading');
  /** Unfinished flow we auto-resumed (or could resume). Not a chooser — a one-line switch. */
  const [resumeCandidate, setResumeCandidate] = useState<BuilderSession | null>(null);
  const [newDraft, setNewDraft] = useState('');
  const [draftSaveState, setDraftSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  /** Separate flag for long-running real test (blocks double submit). */
  const [testing, setTesting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testData, setTestData] = useState('');
  const [testExpected, setTestExpected] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadName, setUploadName] = useState('');
  const [showSourceUpload, setShowSourceUpload] = useState(false);
  const [sourceAdviceDismissed, setSourceAdviceDismissed] = useState(false);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [thinkingElapsed, setThinkingElapsed] = useState(0);
  const sourceInputRef = useRef<HTMLInputElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const hydratedDraftContextRef = useRef<string | null>(null);
  const locked = busy || testing;
  const conversationLocked = locked || !!pendingMessage;

  const onSessionChange = props.onSessionChange;

  const publishSession = useCallback(
    (next: BuilderSession | null) => {
      setSession(next);
      onSessionChange?.(next);
    },
    [onSessionChange],
  );

  // Remember which flow was last opened so the next visit can resume it.
  useEffect(() => {
    if (!session?.id) return;
    window.localStorage.setItem(builderSessionStorageKey, session.id);
  }, [session?.id]);

  useEffect(() => {
    let cancelled = false;
    const lastId = window.localStorage.getItem(builderSessionStorageKey);
    void (async () => {
      try {
        const [sessions, savedDraft] = await Promise.all([
          API.get<BuilderSession[]>('/api/agent-builder/sessions'),
          API.get<{ reply: string; testData: string; testExpected: string }>('/api/agent-builder/draft'),
        ]);
        if (cancelled) return;
        const unfinished = sessions.filter(
          (flow) => flow.status !== 'ACTIVE' && flow.status !== 'ABANDONED',
        );
        const targeted = props.agentId
          ? sessions.find((flow) => flow.agentId === props.agentId && flow.status !== 'ABANDONED')
          : undefined;
        setNewDraft(savedDraft.reply);
        const resume = targeted
          ?? (lastId ? unfinished.find((flow) => flow.id === lastId) : undefined)
          ?? unfinished[0]
          ?? null;
        setResumeCandidate(resume);
        if (!resume) {
          publishSession(null);
          setDraft(savedDraft.reply);
          setTestData('');
          setTestExpected('');
          hydratedDraftContextRef.current = 'new';
          setDraftSaveState(savedDraft.reply ? 'saved' : 'idle');
          setShowSourceUpload(false);
          setSourceAdviceDismissed(false);
          setView('new');
          return;
        }
        const latest = await API.get<BuilderSession>(`/api/agent-builder/sessions/${resume.id}`);
        if (cancelled) return;
        publishSession(latest);
        setDraft(latest.draftState.reply);
        setTestData(latest.draftState.testData);
        setTestExpected(latest.draftState.testExpected);
        hydratedDraftContextRef.current = `session:${latest.id}`;
        setDraftSaveState('saved');
        setShowSourceUpload((latest.brief?.sourceFiles?.length ?? 0) > 0);
        setSourceAdviceDismissed(false);
        setView('session');
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setView('new');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.agentId, publishSession]);

  const draftContext = view === 'new' ? 'new' : view === 'session' && session ? `session:${session.id}` : null;

  // Debounced, redacted server-side autosave. This is deliberately account
  // scoped so the same unfinished text is available on another computer.
  useEffect(() => {
    if (!draftContext || hydratedDraftContextRef.current !== draftContext) return;
    setDraftSaveState('saving');
    const timer = window.setTimeout(() => {
      void API.put('/api/agent-builder/draft', {
        sessionId: session?.id,
        reply: draft,
        testData,
        testExpected,
      })
        .then(() => {
          if (view === 'new') setNewDraft(draft);
          setDraftSaveState('saved');
        })
        .catch(() => setDraftSaveState('error'));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [draft, draftContext, session?.id, testData, testExpected, view]);

  async function persistCurrentDraft() {
    if (!draftContext || hydratedDraftContextRef.current !== draftContext) return;
    setDraftSaveState('saving');
    try {
      await API.put('/api/agent-builder/draft', {
        sessionId: session?.id,
        reply: draft,
        testData,
        testExpected,
      });
      if (view === 'new') setNewDraft(draft);
      setDraftSaveState('saved');
    } catch {
      setDraftSaveState('error');
    }
  }

  async function chooseSession(sessionId: string) {
    if (locked) return;
    setBusy(true);
    setError(null);
    try {
      const latest = await API.get<BuilderSession>(`/api/agent-builder/sessions/${sessionId}`);
      publishSession(latest);
      setDraft(latest.draftState.reply);
      setTestData(latest.draftState.testData);
      setTestExpected(latest.draftState.testExpected);
      hydratedDraftContextRef.current = `session:${latest.id}`;
      setDraftSaveState('saved');
      setShowSourceUpload((latest.brief?.sourceFiles?.length ?? 0) > 0);
      setSourceAdviceDismissed(false);
      setView('session');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function chooseNew() {
    publishSession(null);
    setDraft(newDraft);
    setTestData('');
    setTestExpected('');
    hydratedDraftContextRef.current = 'new';
    setDraftSaveState(newDraft ? 'saved' : 'idle');
    setShowSourceUpload(false);
    setSourceAdviceDismissed(false);
    setView('new');
  }

  async function startFresh() {
    await persistCurrentDraft();
    chooseNew();
  }

  async function closeBuilder() {
    await persistCurrentDraft();
    props.onClose();
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session?.transcript?.length, session?.status, showSourceUpload, testing, pendingMessage]);

  useEffect(() => {
    if (!busy || !pendingMessage) {
      setThinkingElapsed(0);
      return;
    }
    const startedAt = Date.now();
    const update = () => setThinkingElapsed(Math.floor((Date.now() - startedAt) / 1000));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [busy, pendingMessage]);

  // Preserve legacy fixture drafts for old sessions, but the simplified
  // Builder no longer requires a test before activation.
  useEffect(() => {
    if (!session?.brief) return;
    if (!testData && session.brief.testDataHint) setTestData(session.brief.testDataHint);
    if (!testExpected && session.brief.expectedResult) {
      setTestExpected(session.brief.expectedResult);
    }
  }, [session?.brief, testData, testExpected]);

  const testingSessionId = session?.status === 'TESTING' ? session.id : null;
  useEffect(() => {
    if (!testingSessionId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const latest = await API.get<BuilderSession>(
          `/api/agent-builder/sessions/${testingSessionId}`,
        );
        if (!cancelled) publishSession(latest);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    const timer = window.setInterval(() => void poll(), 2500);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [testingSessionId, publishSession]);

  const evolvingSessionId =
    session && ['QUEUED', 'ANALYZING', 'BUILDING'].includes(session.latestIteration?.status ?? '')
      ? session.id
      : null;
  useEffect(() => {
    if (!evolvingSessionId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const latest = await API.get<BuilderSession>(
          `/api/agent-builder/sessions/${evolvingSessionId}`,
        );
        if (!cancelled) publishSession(latest);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    const timer = window.setInterval(() => void poll(), 1500);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [evolvingSessionId, publishSession]);

  // Clear parent checklist on unmount.
  useEffect(() => {
    return () => {
      onSessionChange?.(null);
    };
  }, [onSessionChange]);

  function applyResult(result: BuilderMessageResult) {
    publishSession(result.session);
    if ((result.session.brief?.sourceFiles?.length ?? 0) > 0) setShowSourceUpload(true);
    setView('session');
  }

  async function startSession(message: string) {
    const text = message.trim();
    if (!text || locked) return;
    setBusy(true);
    setError(null);
    setDraft('');
    setPendingMessage(text);
    setThinkingElapsed(0);
    setView('starting');
    try {
      const result = await API.post<BuilderMessageResult>('/api/agent-builder/sessions', {
        message: text,
        agentId: props.agentId ?? undefined,
      });
      applyResult(result);
      setPendingMessage(null);
      setNewDraft('');
      setTestData(result.session.draftState.testData);
      setTestExpected(result.session.draftState.testExpected);
      hydratedDraftContextRef.current = `session:${result.session.id}`;
      setDraftSaveState('saved');
      setShowSourceUpload(false);
      setSourceAdviceDismissed(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitSessionReply(message: string) {
    const text = message.trim();
    if (!text || !session || locked) return;
    if (!['DISCOVERY', 'ACTIVE'].includes(session.status)) return;
    setBusy(true);
    setError(null);
    setDraft('');
    setPendingMessage(text);
    setThinkingElapsed(0);
    try {
      const result = await API.post<BuilderMessageResult>(
        `/api/agent-builder/sessions/${session.id}/messages`,
        { message: text },
      );
      applyResult(result);
      setPendingMessage(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function sendReply() {
    const message = draft.trim();
    if (!message || !session || locked) return;
    await submitSessionReply(message);
  }

  async function authorize(strategy: 'reuse' | 'create') {
    if (!session || locked) return;
    if (!['PLAN_READY', 'AWAITING_FDE', 'AWAITING_TEST_DATA', 'TESTING', 'PASSED', 'FAILED'].includes(session.status)) return;
    setBusy(true);
    setError(null);
    try {
      const targetAgentId =
        strategy === 'reuse'
          ? session.plan?.reuseCandidates[0]?.agentId ?? session.targetAgentId ?? undefined
          : undefined;
      const result = await API.post<BuilderMessageResult>(
        `/api/agent-builder/sessions/${session.id}/authorize`,
        { strategy, targetAgentId },
      );
      applyResult(result);
      if (result.session.status === 'ACTIVE') {
        props.onActivated?.(result.session.agentId ?? result.session.builtAgentId ?? result.session.targetAgentId);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function uploadTrainingSource(file: File) {
    if (!session || locked || uploading) return;
    if (!['DISCOVERY', 'PLAN_READY', 'ACTIVE'].includes(session.status)) return;
    setUploading(true);
    setUploadName(file.name);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const result = await API.upload<BuilderMessageResult>(
        `/api/agent-builder/sessions/${session.id}/files`,
        form,
      );
      applyResult(result);
      if (sourceInputRef.current) sourceInputRef.current.value = '';
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  function adoptSuggestedTest(idea: { name: string; input: string; expected: string }) {
    setTestData(idea.input);
    setTestExpected(idea.expected);
    setError(null);
  }

  async function submitTestDataOnly() {
    if (!session || locked) return;
    if (!testData.trim() || !testExpected.trim()) {
      setError('請填寫測試資料與期望結果');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await API.post<BuilderMessageResult>(
        `/api/agent-builder/sessions/${session.id}/test-data`,
        { data: testData.trim(), expected: testExpected.trim() },
      );
      applyResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Save fixture if needed, then run real test. Holds `testing` for the whole
   * round-trip so double-submit is impossible (test endpoint is long-running).
   */
  async function submitAndTest() {
    if (!session || locked) return;
    const needSave =
      !session.hasTestData || Boolean(testData.trim()) || Boolean(testExpected.trim());
    if (needSave && (!testData.trim() || !testExpected.trim())) {
      setError('請填寫測試資料與期望結果');
      return;
    }

    setTesting(true);
    setError(null);
    try {
      if (needSave) {
        const saveResult = await API.post<BuilderMessageResult>(
          `/api/agent-builder/sessions/${session.id}/test-data`,
          { data: testData.trim(), expected: testExpected.trim() },
        );
        applyResult(saveResult);
      }
      const result = await API.post<BuilderMessageResult>(
        `/api/agent-builder/sessions/${session.id}/test`,
      );
      applyResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  }

  async function exportAgent() {
    if (!session || session.status !== 'ACTIVE' || exporting) return;
    setExporting(true);
    setError(null);
    try {
      await downloadToDevice(`/api/agent-builder/sessions/${session.id}/export`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }

  const status = session?.status;
  const plan = session?.plan;
  const progress = session?.progress;
  const transcript = session?.transcript ?? [];
  const latestIteration = session?.latestIteration ?? null;
  const suggestedTest = latestIteration?.harness?.testIdeas?.[0] ?? null;
  const evolutionBusy = ['QUEUED', 'ANALYZING', 'BUILDING'].includes(latestIteration?.status ?? '');
  const openAgentId = session?.builtAgentId ?? session?.targetAgentId ?? null;

  const showPlan =
    !!plan &&
    (status === 'PLAN_READY' ||
      status === 'AWAITING_FDE' ||
      status === 'AWAITING_TEST_DATA' ||
      status === 'TESTING' ||
      status === 'PASSED' ||
      status === 'FAILED' ||
      status === 'ACTIVE' ||
      status === 'BUILDING');

  const showAuthorize = ['PLAN_READY', 'AWAITING_FDE', 'AWAITING_TEST_DATA', 'TESTING', 'PASSED', 'FAILED'].includes(status ?? '');
  const showTestPanel = false;
  const canReuse = (plan?.reuseCandidates?.length ?? 0) > 0;
  const recommendedReuse = plan?.strategyRecommendation === 'reuse' && canReuse;

  if (view === 'loading') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-brand" />建立 AI 員工</div>
          <button type="button" className="btn-ghost h-8 w-8 p-0" onClick={() => props.onClose()} aria-label="關閉建立流程"><X className="h-4 w-4" /></button>
        </div>
        <div className="grid min-h-0 flex-1 place-items-center"><Spinner className="h-5 w-5" /></div>
      </div>
    );
  }

  // ── Empty state for a new flow (no chooser intercept) ─────────────────────
  if (view === 'new' && !session) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4 text-brand" />
            建立 AI 員工
          </div>
          <button type="button" className="btn-ghost h-8 w-8 p-0" onClick={() => void closeBuilder()} aria-label="關閉建立流程"><X className="h-4 w-4" /></button>
        </div>
        {resumeCandidate && (
          <div className="flex items-center justify-between gap-3 border-b border-border bg-brand/[0.04] px-4 py-2 text-xs">
            <span className="text-muted">
              繼續上次的建置（
              <span className="text-fg">另開新的</span>
              ）
            </span>
            <button
              type="button"
              className="btn-ghost h-7 gap-1 px-2 text-xs text-brand"
              disabled={busy}
              onClick={() => void chooseSession(resumeCandidate.id)}
            >
              <History className="h-3.5 w-3.5" />
              回到上次
            </button>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8">
          <div className="w-full max-w-lg space-y-6">
            <div className="space-y-2 text-center">
              <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">
                告訴我你想請一位 AI 員工做什麼
              </h2>
              <p className="text-sm text-muted">
                用日常語言描述業務目標即可。我會一次只問一個關鍵問題；整理出第一份可用內容後，就能直接交代工作。
              </p>
            </div>

            <div className="flex flex-wrap justify-center gap-2">
              {BUILDER_STARTER_EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  className="rounded-full border border-border bg-panel/60 px-3 py-1.5 text-left text-xs text-muted transition-colors hover:border-brand/40 hover:bg-brand/5 hover:text-fg"
                  disabled={locked}
                  onClick={() => setDraft(ex)}
                >
                  {ex}
                </button>
              ))}
            </div>

            {error && (
              <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-center text-sm text-rose-300">
                {error}
              </p>
            )}

            <div className="flex items-end gap-2">
              <label className="sr-only" htmlFor="builder-start-input">
                描述你想請 AI 員工做的事
              </label>
              <textarea
                id="builder-start-input"
                className="input min-h-[88px] max-h-40 flex-1 resize-y"
                placeholder="例如：每天早上整理帳款郵件做成表，供財務覆核…"
                value={draft}
                rows={3}
                disabled={locked}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void startSession(draft);
                  }
                }}
              />
              <button
                type="button"
                className="btn-primary h-10 shrink-0"
                disabled={!draft.trim() || locked}
                onClick={() => void startSession(draft)}
                aria-label="開始建立"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
            <div className="flex items-center justify-end gap-1.5 text-[11px] text-muted" aria-live="polite">
              <Save className="h-3.5 w-3.5" />
              {draftSaveState === 'saving' ? '正在儲存…' : draftSaveState === 'error' ? '草稿儲存失敗，將自動重試' : draftSaveState === 'saved' ? '已儲存，可在其他電腦繼續' : '輸入後會自動儲存'}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // The first request has not created a durable session yet, but the user
  // should already be in the conversation. Never leave them staring at the
  // original form while the adaptive interview is being prepared.
  if (view === 'starting' && pendingMessage) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="h-4 w-4 shrink-0 text-brand" />
              建立 AI 員工
            </div>
            <div className="truncate text-xs text-muted">
              {busy ? '正在理解需求' : '回覆暫時未送達'}
            </div>
          </div>
          <button
            type="button"
            className="btn-ghost h-8 w-8 p-0"
            onClick={() => void closeBuilder()}
            aria-label="關閉建立流程"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
          <div className="flex justify-end">
            <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-brand/20 px-3 py-2 text-sm">
              {pendingMessage}
            </div>
          </div>
          {busy && <BuilderThinkingBubble elapsedSeconds={thinkingElapsed} />}
          {!busy && error && (
            <div className="flex justify-start" role="alert">
              <div className="max-w-[90%] rounded-2xl rounded-bl-md border border-rose-500/30 bg-rose-500/10 px-3 py-3 text-sm">
                <div className="font-medium text-rose-300">剛才沒有成功收到回覆</div>
                <p className="mt-1 text-xs text-muted">你的需求仍保留在對話中，可以直接重試或返回修改。</p>
                <div className="mt-2 flex gap-2">
                  <button type="button" className="btn-primary h-8 text-xs" onClick={() => void startSession(pendingMessage)}>
                    再試一次
                  </button>
                  <button
                    type="button"
                    className="btn-ghost h-8 text-xs"
                    onClick={() => {
                      setDraft(pendingMessage);
                      setPendingMessage(null);
                      setError(null);
                      setView('new');
                    }}
                  >
                    修改需求
                  </button>
                </div>
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        <div className="border-t border-border p-3">
          <div className="flex items-end gap-2">
            <textarea
              className="input min-h-[44px] flex-1 resize-none"
              value=""
              rows={2}
              disabled
              readOnly
              aria-label="等待 AI 回覆"
              placeholder="AI 回覆後，可以在這裡繼續補充…"
            />
            <button type="button" className="btn-primary h-9 shrink-0" disabled aria-label="等待 AI 回覆">
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Defensive recovery for an interrupted/failed session load. Normal flows
  // reach this point only after an exact session has been selected or created.
  if (!session) {
    return (
      <div className="grid h-full min-h-0 place-items-center px-4">
        <div className="card max-w-md space-y-3 p-5 text-center">
          <p className="text-sm text-muted">這筆建立紀錄目前無法載入，請重新開始。</p>
          <button type="button" className="btn-primary mx-auto" onClick={() => chooseNew()}>
            開始新的建置
          </button>
        </div>
      </div>
    );
  }

  // ── Active session ─────────────────────────────────────────────────────────
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4 shrink-0 text-brand" />
            建立 AI 員工
          </div>
          <div className="truncate text-xs text-muted">
            {builderStatusLabel(status ?? '')}
            {progress ? ` · 已釐清 ${progress.answeredKeys.length} 個關鍵決策` : ''}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <span className={cn('hidden items-center gap-1 text-[11px] sm:inline-flex', draftSaveState === 'error' ? 'text-rose-400' : 'text-muted')}>
            <Save className="h-3.5 w-3.5" />
            {draftSaveState === 'saving' ? '儲存中…' : draftSaveState === 'error' ? '儲存失敗' : '已自動儲存'}
          </span>
          <button type="button" className="btn-ghost h-8 w-8 p-0" onClick={() => void closeBuilder()} aria-label="關閉建立流程"><X className="h-4 w-4" /></button>
        </div>
      </div>
      {resumeCandidate && session.id === resumeCandidate.id && (
        <div className="flex items-center justify-between gap-3 border-b border-border bg-brand/[0.04] px-4 py-2 text-xs">
          <span>
            繼續上次的建置（
            <button
              type="button"
              className="font-medium text-brand hover:underline"
              disabled={locked}
              onClick={() => void startFresh()}
            >
              另開新的
            </button>
            ）
          </span>
          <span className="truncate text-muted">{savedFlowName(session)}</span>
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {/* Durable transcript */}
        {transcript.map((entry, i) => {
          const key = `${entry.at}-${i}`;
          if (entry.role === 'user') {
            return (
              <div key={key} className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-brand/20 px-3 py-2 text-sm">
                  {entry.content}
                </div>
              </div>
            );
          }
          if (entry.role === 'system') {
            return (
              <div key={key} className="text-center text-xs text-muted">
                {entry.content}
              </div>
            );
          }
          return (
            <div key={key} className="flex justify-start">
              <div className="max-w-[90%] whitespace-pre-wrap rounded-2xl rounded-bl-md bg-black/5 px-3 py-2 text-sm dark:bg-white/10">
                {entry.content}
              </div>
            </div>
          );
        })}

        {pendingMessage && (
          <div className="flex justify-end">
            <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-brand/20 px-3 py-2 text-sm">
              {pendingMessage}
            </div>
          </div>
        )}

        {pendingMessage && busy && <BuilderThinkingBubble elapsedSeconds={thinkingElapsed} />}

        {pendingMessage && !busy && error && (
          <div className="flex justify-start" role="alert">
            <div className="max-w-[90%] rounded-2xl rounded-bl-md border border-rose-500/30 bg-rose-500/10 px-3 py-3 text-sm">
              <div className="font-medium text-rose-300">剛才沒有成功收到回覆</div>
              <p className="mt-1 text-xs text-muted">你送出的內容仍保留著，可以重試或修改後再送。</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className="btn-primary h-8 text-xs" onClick={() => void submitSessionReply(pendingMessage)}>
                  再試一次
                </button>
                <button
                  type="button"
                  className="btn-ghost h-8 text-xs"
                  onClick={() => {
                    setDraft(pendingMessage);
                    setPendingMessage(null);
                    setError(null);
                  }}
                >
                  修改後再送
                </button>
              </div>
            </div>
          </div>
        )}

        {latestIteration && evolutionBusy && (
          <div
            className="flex justify-start"
            role="status"
            aria-live="polite"
            aria-label="正在更新這位員工"
          >
            <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-brand/20 bg-brand/[0.05] px-3 py-3 text-sm">
              <div className="flex items-center gap-2 font-medium">
                <Loader2 className="h-4 w-4 animate-spin text-brand" />
                我正在把這次的新理解整理進這位員工
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                你可以繼續補充或改變想法；我會保留每一次調整，完成後在這裡告訴你這次學會了什麼。
              </p>
            </div>
          </div>
        )}

        {latestIteration?.status === 'READY' && latestIteration.userSummary && (
          <div className="flex justify-start">
            <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-emerald-500/25 bg-emerald-500/[0.08] px-3 py-3 text-sm">
              <div className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-200">
                <CheckCircle2 className="h-4 w-4" />
                這位員工又學會了一些東西
              </div>
              <p className="mt-1.5 leading-relaxed">{latestIteration.userSummary}</p>
              {latestIteration.changes.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs text-muted">
                  {latestIteration.changes.slice(0, 4).map((change, index) => (
                    <li key={`${latestIteration.id}-${index}`} className="flex gap-1.5">
                      <span className="text-emerald-500">✓</span>
                      <span>{change.summary}</span>
                    </li>
                  ))}
                </ul>
              )}
              {(latestIteration.harness?.testIdeas.length ?? 0) > 0 && status === 'DISCOVERY' && (
                <button
                  type="button"
                  className="btn-ghost mt-2 h-8 text-xs"
                  onClick={() => {
                    const idea = latestIteration.harness!.testIdeas[0];
                    setTestData(idea.input);
                    setTestExpected(idea.expected);
                    setDraft(`我想先用「${idea.name}」測試看看，請幫我確認這組測試是否合理。`);
                  }}
                >
                  採用它建議的第一組測試
                </button>
              )}
            </div>
          </div>
        )}

        {latestIteration?.status === 'FAILED' && (
          <div className="flex justify-start">
            <div className="max-w-[90%] rounded-2xl rounded-bl-md border border-amber-500/25 bg-amber-500/10 px-3 py-3 text-sm">
              <div className="font-medium text-amber-600 dark:text-amber-300">這次學習草稿尚未整理完成</div>
              <p className="mt-1 text-xs text-muted">對話內容已保存，你可以繼續聊天，系統會重新整理下一版訓練內容。</p>
            </div>
          </div>
        )}

        {testing && (
          <div
            className="flex items-center gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-3 text-sm text-sky-800 dark:text-sky-200"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            <div>
              <div className="font-medium">正在真實試跑中…</div>
              <div className="text-xs opacity-80">
                這可能需要幾分鐘。請勿關閉或重複送出；結果會在此顯示。
              </div>
            </div>
          </div>
        )}

        {(status === 'DISCOVERY' || status === 'PLAN_READY' || status === 'ACTIVE') &&
          progress?.turn?.sourceAdvice.mode === 'recommended' &&
          !sourceAdviceDismissed &&
          !showSourceUpload &&
          (session.brief?.sourceFiles?.length ?? 0) === 0 && (
            <div className="rounded-lg border border-brand/25 bg-brand/[0.04] px-3 py-3">
              <div className="flex items-start gap-2">
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">範本可能有幫助，但不是必填</div>
                  <p className="mt-1 text-xs leading-relaxed text-muted">
                    {progress.turn.sourceAdvice.reason}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn-ghost h-8 text-xs"
                      onClick={() => setShowSourceUpload(true)}
                    >
                      <Upload className="h-3.5 w-3.5" />
                      提供範本
                    </button>
                    <button
                      type="button"
                      className="btn-ghost h-8 text-xs text-muted"
                      onClick={() => setSourceAdviceDismissed(true)}
                    >
                      暫時不用，繼續對話
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

        {(status === 'DISCOVERY' || status === 'PLAN_READY' || status === 'ACTIVE') && showSourceUpload && (
          <div className="card space-y-3 border-brand/25 bg-brand/[0.04] p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Upload className="h-4 w-4 text-brand" />
                提供範本或參考資料
                <span className="badge bg-black/5 text-muted dark:bg-white/5">選填</span>
              </div>
              {(session.brief?.sourceFiles?.length ?? 0) === 0 && (
                <button
                  type="button"
                  className="btn-ghost h-7 px-2 text-xs text-muted"
                  onClick={() => {
                    setShowSourceUpload(false);
                    setSourceAdviceDismissed(true);
                  }}
                >
                  先不用
                </button>
              )}
            </div>
            <p className="text-xs leading-relaxed text-muted">
              可加入去識別的 Excel、CSV、文字、PDF 或 Word 作為參考。沒有檔案也能繼續，系統會改用對話釐清。
            </p>
            <input
              ref={sourceInputRef}
              type="file"
              accept=".xlsx,.xls,.csv,.tsv,.md,.txt,.pdf,.docx"
              className="block w-full text-xs text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-brand/10 file:px-3 file:py-2 file:text-xs file:font-medium file:text-brand hover:file:bg-brand/20"
              disabled={locked || uploading}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void uploadTrainingSource(file);
              }}
            />
            {uploading && (
              <div className="flex items-center gap-2 text-xs text-muted" role="status">
                <Spinner className="h-3.5 w-3.5" /> 正在讀取 {uploadName}…
              </div>
            )}
            {(session.brief?.sourceFiles?.length ?? 0) > 0 && (
              <ul className="space-y-1.5 text-xs">
                {session.brief!.sourceFiles!.map((file) => (
                  <li key={file.name} className="flex items-center gap-2 rounded-md bg-black/5 px-2.5 py-2 dark:bg-white/5">
                    <FileText className="h-3.5 w-3.5 text-brand" />
                    <span className="font-medium">{file.name}</span>
                    <span className="ml-auto text-muted">已解析 {file.content.length.toLocaleString()} 字</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {(status === 'DISCOVERY' || status === 'PLAN_READY' || status === 'ACTIVE') &&
          !showSourceUpload &&
          (session.brief?.sourceFiles?.length ?? 0) > 0 && (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg border border-border/60 px-3 py-2 text-left text-xs text-muted hover:border-brand/30"
              onClick={() => setShowSourceUpload(true)}
            >
              <FileText className="h-3.5 w-3.5 text-brand" />
              已加入 {session.brief!.sourceFiles!.length} 份參考資料
            </button>
          )}

        {/* Plan (business language) */}
        {showPlan && plan && (
          <div className="card space-y-3 border-border/80 bg-panel/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-medium">計畫摘要</div>
              <span className="badge bg-black/10 text-muted dark:bg-white/10">
                {builderStatusLabel(status ?? '')}
              </span>
            </div>
            <p className="text-sm leading-relaxed text-muted">{plan.summary}</p>

            <div className="rounded-md border border-border/60 bg-black/[0.02] px-3 py-2 text-xs leading-relaxed text-muted dark:bg-white/[0.03]">
              <span className="font-medium text-fg/80">最小權限：</span>
              {plan.privilegeNote}
            </div>

            {plan.reuseCandidates.length > 0 && (
              <div>
                <div className="mb-1.5 text-xs font-medium text-muted">可沿用的既有員工</div>
                <ul className="space-y-1.5 text-sm">
                  {plan.reuseCandidates.map((c) => (
                    <li key={c.agentId} className="flex gap-2">
                      <Users className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" />
                      <span>
                        <span className="font-medium">{c.name}</span>
                        <span className="text-muted"> — {c.reason}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {plan.skillMatches.length > 0 && (
              <div>
                <div className="mb-1.5 text-xs font-medium text-muted">可參考的既有技能</div>
                <ul className="space-y-1 text-sm">
                  {plan.skillMatches.map((s) => (
                    <li key={s.skillId}>
                      <span className="font-medium">{s.name}</span>
                      <span className="text-muted"> — {s.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {(plan.connections.some((c) => !c.available) || plan.gaps.length > 0) && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
                <div className="font-medium">正式上線前需補齊的連線</div>
                <ul className="mt-1.5 list-disc space-y-1 pl-4">
                  {(plan.gaps.length > 0
                    ? plan.gaps
                    : plan.connections.filter((c) => !c.available)
                  ).map((g) => (
                    <li key={g.label}>
                      {g.label}：{g.actionNeeded}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {plan.proposedAgentName && (
              <div className="text-xs text-muted">
                建議名稱：
                <span className="font-medium text-fg/80">
                  {plan.proposedAgentName}
                  {plan.proposedSkillName ? ` · 技能「${plan.proposedSkillName}」` : ''}
                </span>
              </div>
            )}

            {showAuthorize && (
              <div className="space-y-2 border-t border-border pt-3">
                <div className="text-xs font-medium text-muted">同步中斷時重新套用</div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    className={cn(
                      'btn-primary flex-1 justify-center text-sm',
                      !recommendedReuse && canReuse ? 'opacity-90' : '',
                    )}
                    disabled={locked || !canReuse}
                    onClick={() => void authorize('reuse')}
                    title={!canReuse ? '目前沒有可沿用的員工' : undefined}
                  >
                    {locked ? (
                      <Spinner className="border-white/40 border-t-white" />
                    ) : (
                      <Users className="h-4 w-4" />
                    )}
                    更新既有員工
                    {recommendedReuse ? '（建議）' : ''}
                  </button>
                  <button
                    type="button"
                    className={cn(
                      'flex-1 justify-center text-sm',
                      recommendedReuse ? 'btn-ghost border border-border' : 'btn-primary',
                    )}
                    disabled={locked}
                    onClick={() => void authorize('create')}
                  >
                    {locked ? (
                      <Spinner className="border-white/40 border-t-white" />
                    ) : (
                      <UserPlus className="h-4 w-4" />
                    )}
                    重新建立可用員工
                    {!recommendedReuse ? '（建議）' : ''}
                  </button>
                </div>
                <p className="text-[11px] leading-relaxed text-muted">
                  正常訓練不需要按這裡；第一份完整內容會自動成為可使用的員工。只有舊版資料或同步中斷時才需要重新套用。
                </p>
              </div>
            )}

            {status === 'AWAITING_FDE' && (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
                這是舊版留下的待啟用狀態。請按上方按鈕直接完成啟用。
              </p>
            )}
          </div>
        )}

        {/* Test fixture + run */}
        {showTestPanel && suggestedTest && (
          <div className="card space-y-3 border-border/80 p-4">
            <div className="text-sm font-medium">建議測試</div>
            <p className="text-xs text-muted">
              已依目前草稿準備一組測試。可一鍵採用，或改為自行填寫。試跑是真實執行，失敗不會假裝通過。
            </p>
            <div className="rounded-md border border-brand/25 bg-brand/[0.04] px-3 py-3">
              <div className="text-sm font-medium">{suggestedTest.name}</div>
              <div className="mt-2 space-y-2 text-xs leading-relaxed text-muted">
                <div>
                  <div className="font-medium text-fg/80">測試資料</div>
                  <p className="mt-0.5 whitespace-pre-wrap">{suggestedTest.input}</p>
                </div>
                <div>
                  <div className="font-medium text-fg/80">期望結果</div>
                  <p className="mt-0.5 whitespace-pre-wrap">{suggestedTest.expected}</p>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-primary text-sm"
                disabled={locked}
                onClick={() => adoptSuggestedTest(suggestedTest)}
              >
                採用建議測試
              </button>
              <button
                type="button"
                className="btn-ghost border border-border text-sm"
                disabled={
                  locked ||
                  (!session.hasTestData && (!testData.trim() || !testExpected.trim()))
                }
                onClick={() => void submitAndTest()}
              >
                {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                {testing ? '試跑中…' : status === 'FAILED' ? '重新試跑' : '開始試跑'}
              </button>
            </div>
            <details className="rounded-md border border-border/60 px-3 py-2">
              <summary className="cursor-pointer text-xs font-medium text-muted">自行填寫測試資料</summary>
              <div className="mt-3 space-y-3">
                <label className="block space-y-1">
                  <span className="label">測試資料</span>
                  <textarea
                    className="input min-h-[80px] w-full resize-y text-sm"
                    placeholder="例如：三封假帳款郵件摘要（金額、廠商、日期）"
                    value={testData}
                    onChange={(e) => setTestData(e.target.value)}
                    disabled={locked}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="label">期望結果</span>
                  <textarea
                    className="input min-h-[60px] w-full resize-y text-sm"
                    placeholder="例如：表內有三列、金額合計正確、標註待審項目"
                    value={testExpected}
                    onChange={(e) => setTestExpected(e.target.value)}
                    disabled={locked}
                  />
                </label>
                <button
                  type="button"
                  className="btn-ghost text-sm"
                  disabled={locked || !testData.trim() || !testExpected.trim()}
                  onClick={() => void submitTestDataOnly()}
                >
                  {busy && !testing ? <Spinner /> : null}
                  儲存測試資料
                </button>
              </div>
            </details>
            {session.hasTestData && (
              <p className="text-[11px] text-muted">已儲存一組測試資料；可覆寫後再試跑。</p>
            )}
          </div>
        )}

        {showTestPanel && !suggestedTest && (
          <div className="card space-y-3 border-border/80 p-4">
            <div className="text-sm font-medium">測試資料（必填）</div>
            <p className="text-xs text-muted">
              請提供一組去識別後的代表性資料與期望結果。試跑是真實執行，失敗不會假裝通過。
            </p>
            <label className="block space-y-1">
              <span className="label">測試資料</span>
              <textarea
                className="input min-h-[80px] w-full resize-y text-sm"
                placeholder="例如：三封假帳款郵件摘要（金額、廠商、日期）"
                value={testData}
                onChange={(e) => setTestData(e.target.value)}
                disabled={locked}
              />
            </label>
            <label className="block space-y-1">
              <span className="label">期望結果</span>
              <textarea
                className="input min-h-[60px] w-full resize-y text-sm"
                placeholder="例如：表內有三列、金額合計正確、標註待審項目"
                value={testExpected}
                onChange={(e) => setTestExpected(e.target.value)}
                disabled={locked}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-ghost text-sm"
                disabled={locked || !testData.trim() || !testExpected.trim()}
                onClick={() => void submitTestDataOnly()}
              >
                {busy && !testing ? <Spinner /> : null}
                儲存測試資料
              </button>
              <button
                type="button"
                className="btn-primary text-sm"
                disabled={
                  locked ||
                  (!session.hasTestData && (!testData.trim() || !testExpected.trim()))
                }
                onClick={() => void submitAndTest()}
              >
                {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                {testing ? '試跑中…' : status === 'FAILED' ? '重新試跑' : '開始試跑'}
              </button>
            </div>
            {session.hasTestData && (
              <p className="text-[11px] text-muted">已儲存一組測試資料；可覆寫後再試跑。</p>
            )}
          </div>
        )}

        {/* Manual pass/fail vs production blockers */}
        {session.testResult && !testing && (
          <div className="space-y-2">
            <div
              className={cn(
                'rounded-lg border px-3 py-2 text-sm',
                session.testResult.ok
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-100'
                  : 'border-rose-500/30 bg-rose-500/10 text-rose-300',
              )}
              role="status"
            >
              <div className="font-medium">
                {session.testResult.ok ? '手動試跑通過' : '手動試跑未通過'}
              </div>
              <div className="mt-0.5 text-sm opacity-90">{session.testResult.summary}</div>
              {session.testResult.detail && (
                <div className="mt-1 text-xs opacity-75">{session.testResult.detail}</div>
              )}
            </div>
            {session.testResult.productionBlockers?.length > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
                <div className="font-medium">正式上線仍受阻（與手動試跑結果分開）</div>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
                  {session.testResult.productionBlockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {status === 'ACTIVE' && (
          <div className="space-y-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-4 text-center">
            <div className="flex items-center justify-center gap-2 text-sm font-medium text-emerald-900 dark:text-emerald-100">
              <CheckCircle2 className="h-4 w-4" />
              現在可以使用，也可以繼續教它
            </div>
            {openAgentId ? (
              <div className="flex flex-wrap justify-center gap-2">
                <Link
                  href={`/work?agent=${encodeURIComponent(openAgentId)}`}
                  className="btn-primary inline-flex justify-center text-sm"
                  onClick={() => props.onActivated?.(openAgentId)}
                >
                  開啟這位員工
                </Link>
                <button type="button" className="btn-ghost border border-border text-sm" disabled={exporting} onClick={() => void exportAgent()}>
                  {exporting ? <Spinner /> : <Download className="h-4 w-4" />}
                  匯出 ZIP
                </button>
              </div>
            ) : (
              <button type="button" className="btn-ghost text-sm" onClick={props.onClose}>
                返回工作台
              </button>
            )}
          </div>
        )}

        {status === 'BUILDING' && (
          <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在建立草稿…
          </div>
        )}

        <div ref={endRef} />
      </div>

      {/* Ongoing co-design composer: a callable employee can keep learning in
          the same durable session. Each complete snapshot updates it in place. */}
      {(status === 'DISCOVERY' || status === 'ACTIVE') && (
        <div className="border-t border-border p-3">
          {error && <p className="mb-2 text-sm text-rose-400">{error}</p>}
          {(progress?.turn?.suggestions?.length ?? 0) > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5" aria-label="建議回答">
              {progress!.turn!.suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-left text-xs transition-colors',
                    draft === suggestion
                      ? 'border-brand/50 bg-brand/15 text-fg'
                      : 'border-border bg-panel/50 text-muted hover:border-brand/40 hover:text-fg',
                  )}
                  disabled={conversationLocked}
                  onClick={() => setDraft(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <label className="sr-only" htmlFor="builder-reply-input">
              回答目前問題
            </label>
            <textarea
              id="builder-reply-input"
              className="input min-h-[44px] max-h-32 flex-1 resize-y"
              placeholder={status === 'ACTIVE'
                ? '告訴我你想讓這位員工再學會或改變什麼…'
                : progress?.turn?.question ?? '用你的方式回答即可…'}
              value={draft}
              rows={2}
              disabled={conversationLocked}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void sendReply();
                }
              }}
            />
            <button
              type="button"
              className="btn-primary h-9 shrink-0"
              disabled={!draft.trim() || conversationLocked}
              onClick={() => void sendReply()}
              aria-label="送出回答"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-2 flex items-center justify-between gap-3">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-fg"
              onClick={() => {
                setShowSourceUpload((value) => !value);
                setSourceAdviceDismissed(false);
              }}
              disabled={conversationLocked}
            >
              <Upload className="h-3.5 w-3.5" />
              {showSourceUpload ? '收起參考資料' : '提供範本或資料（選填）'}
            </button>
            <span className="text-[11px] text-muted">也可以完全用自己的方式回答</span>
          </div>
        </div>
      )}

      {status !== 'DISCOVERY' && error && (
        <div className="border-t border-border px-4 py-2 text-sm text-rose-400" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/** Right-rail checklist for builder mode (progress + steps). */
export function AgentBuilderRail({ session }: { session: BuilderSession | null }) {
  const status = session?.status;
  const progress = session?.progress;
  const answered = new Set(progress?.answeredKeys ?? []);
  const current = progress?.currentKey;
  const latestIteration = session?.latestIteration ?? null;
  const hasWorkingAgent = Boolean(session?.agentId || session?.builtAgentId || session?.targetAgentId);

  const steps: Array<{ key: string; label: string; done: boolean; active: boolean }> = [
    {
      key: 'created',
      label: 'Agent 已建立',
      done: hasWorkingAgent,
      active: !hasWorkingAgent,
    },
    {
      key: 'learning',
      label: '持續學習與改善',
      done: status === 'PASSED',
      active: status === 'ACTIVE' || status === 'DISCOVERY' || status === 'PLAN_READY' || status === 'BUILDING',
    },
    {
      key: 'test',
      label: '測試與改善',
      done: status === 'PASSED',
      active: status === 'AWAITING_TEST_DATA' || status === 'TESTING' || status === 'FAILED',
    },
  ];

  const fieldOrder = [
    'objective',
    'inputs',
    'outputs',
    'process',
    'exceptions',
    'permissions',
    'testData',
  ] as const;
  const fieldLabels: Record<string, string> = {
    objective: '痛點與希望改變的結果',
    inputs: '現況與可用線索',
    outputs: '理想成果',
    process: '可能的工作方式',
    exceptions: '仍有分歧的地方',
    permissions: '需要人工確認的動作',
    testData: '值得先試驗的想法',
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border p-4">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
          建立進度
        </div>
        <div className="mt-2 text-sm font-medium">
          {status ? builderStatusLabel(status) : '從業務目標開始'}
        </div>
        {progress && (
          <div className="mt-2 rounded-md bg-black/[0.03] px-2.5 py-2 text-[11px] leading-relaxed text-muted dark:bg-white/[0.04]">
            問題會沿著你的痛點與決策分支改變；你可以隨時補充或推翻先前想法。
          </div>
        )}
        {session && session.iterations.length > 0 && (
          <div className="mt-2 flex items-center justify-between text-xs">
            <span className="text-muted">員工學習紀錄</span>
            <span className="badge bg-brand/10 text-brand">第 {latestIteration?.sequence ?? session.iterations.length} 版</span>
          </div>
        )}
      </div>

      <div className="border-b border-border p-4">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">
          階段
        </div>
        <ul className="space-y-2">
          {steps.map((s) => (
            <li key={s.key} className="flex items-start gap-2 text-sm">
              {s.done ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
              ) : s.active ? (
                <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-amber-500" />
              ) : (
                <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
              )}
              <span className={cn(s.active && 'font-medium', s.done && 'text-muted')}>
                {s.label}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {(!status || status === 'DISCOVERY') && (
        <div className="flex-1 overflow-y-auto p-4">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">
            目前共同理解
          </div>
          {latestIteration?.understanding ? (
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-fg/90">{latestIteration.understanding.northStar}</p>
              {latestIteration.understanding.decisions.length > 0 && (
                <ul className="space-y-2">
                  {latestIteration.understanding.decisions.slice(-5).map((decision, index) => (
                    <li key={`${decision.topic}-${index}`} className="flex items-start gap-2 text-xs text-muted">
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" />
                      <span><span className="text-fg/80">{decision.topic}：</span>{decision.decision}</span>
                    </li>
                  ))}
                </ul>
              )}
              {latestIteration.understanding.openBranches.length > 0 && (
                <div>
                  <div className="mb-1.5 text-[11px] font-medium text-muted">接下來值得探索</div>
                  <ul className="space-y-1.5">
                    {latestIteration.understanding.openBranches.slice(0, 4).map((branch, index) => (
                      <li key={`${branch.topic}-${index}`} className="text-xs text-muted">• {branch.topic}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <ul className="space-y-2">
              {fieldOrder.filter((key) => answered.has(key) || current === key).map((key) => {
              const done = answered.has(key);
              const active = current === key;
              return (
                <li key={key} className="flex items-start gap-2 text-sm">
                  {done ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" />
                  ) : active ? (
                    <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-amber-500" />
                  ) : <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-amber-500" />}
                  <span
                    className={cn(
                      'text-xs',
                      active && 'font-medium text-fg',
                      done && 'text-muted',
                    )}
                  >
                    {active ? `正在釐清：${fieldLabels[key]}` : fieldLabels[key]}
                  </span>
                </li>
              );
              })}
            </ul>
          )}
        </div>
      )}

      <div className="mt-auto space-y-2 p-4 text-[11px] leading-relaxed text-muted">
        <p>不會自動開通寄信、雲端寫入或不可逆操作。</p>
        <p>完整訓練內容同步後，技能會直接套用到同一位員工。</p>
      </div>
    </div>
  );
}
