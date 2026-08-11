import type { Metadata } from 'next';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleUserRound,
  Cloud,
  Code2,
  Download,
  FileArchive,
  FileCheck2,
  FileCode2,
  FileText,
  KeyRound,
  Laptop,
  LockKeyhole,
  MessageSquareText,
  PackageCheck,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
  Workflow,
} from 'lucide-react';

export const metadata: Metadata = {
  title: 'Agent Builder 安裝中心 — Lazyoffice AIOS',
  description: '在 ChatGPT、Codex 或 Claude 安裝 Lazyoffice AIOS Agent Builder，並下載 Plugin、Skill 與安裝文件。',
};

const DOWNLOAD_ROOT = '/downloads/agent-builder';
const REMOTE_MCP = 'https://aios-mcp.lazyoffice.app/mcp';

type DownloadItem = {
  title: string;
  filename: string;
  description: string;
  icon: LucideIcon;
  primary?: boolean;
};

const downloads: DownloadItem[] = [
  {
    title: 'Universal Plugin',
    filename: 'lazyoffice-aios-builder-plugin.zip',
    description: 'ChatGPT／Codex 與 Claude Plugin 共用套件，包含 Skill、Remote MCP 設定與 Claude Hooks。',
    icon: PackageCheck,
    primary: true,
  },
  {
    title: '跨平台一鍵安裝包',
    filename: 'lazyoffice-aios-one-click-install.zip',
    description: '提供 macOS 與 Windows 安裝器，適合 Claude Code／Cowork 客戶端部署。',
    icon: Laptop,
  },
  {
    title: '獨立 Agent Builder Skill',
    filename: 'build-aios-agent.skill.zip',
    description: '只需要 Skill 時使用；Claude Chat 仍需另外加入 Remote MCP Connector。',
    icon: FileArchive,
  },
  {
    title: 'Remote MCP 設定',
    filename: 'aios-remote-mcp.json',
    description: '只連線 Lazyoffice 公開服務，不會在客戶電腦啟動 AIOS Server。',
    icon: FileCode2,
  },
  {
    title: '完整安裝說明',
    filename: 'AIOS-Agent-Builder-Installation-Guide.zh-TW.md',
    description: '可下載、轉寄與版本管理的繁體中文 Markdown 操作文件。',
    icon: FileText,
  },
  {
    title: 'SHA-256 校驗碼',
    filename: 'SHA256SUMS.txt',
    description: '下載後可核對壓縮包是否完整，避免使用損毀或遭替換的檔案。',
    icon: FileCheck2,
  },
];

const chatGptSteps = [
  {
    title: '開啟 Developer mode',
    body: '在 ChatGPT Settings → Security and login 開啟 Developer mode，進入 Plugins／Connectors 管理頁。',
  },
  {
    title: '加入 Lazyoffice Remote MCP',
    body: `新增 Remote MCP，網址填入 ${REMOTE_MCP}。不需要安裝本機 Server，也不要填 127.0.0.1。`,
  },
  {
    title: '登入 AIOS 並授權',
    body: '瀏覽器會開啟 Lazyoffice AIOS OAuth 頁。使用自己的 AIOS 帳號登入，連線只取得 Agent Builder 草稿權限。',
  },
  {
    title: '直接描述要建立的員工',
    body: '例如：「幫我建立一位每天整理 AI 新聞、附來源並產生主管摘要的 AI 員工。」系統會邊訪談、邊在背景更新草稿。',
  },
];

const claudeSteps = [
  {
    title: '下載安裝套件',
    body: 'Claude Code／Cowork 建議使用 Universal Plugin 或一鍵安裝包；純 Claude Chat 可使用獨立 Skill。',
  },
  {
    title: '安裝 Plugin 或 Skill',
    body: 'Plugin 會帶入 Remote MCP 與支援環境的 UserPromptSubmit／Stop Hooks；純 Skill 不會自動新增 Connector。',
  },
  {
    title: '完成 OAuth 連線',
    body: '第一次呼叫 AIOS 工具時，用自己的 AIOS 帳號授權。套件內沒有共用帳號、密碼或靜態 Token。',
  },
  {
    title: '開始自然訓練',
    body: '直接和 Claude 對話。Claude Code 的 Hooks 會保存正常完成的回合；沒有 Hooks 的介面會由 Skill 主動同步。',
  },
];

function StepList({ steps }: { steps: typeof chatGptSteps }) {
  return (
    <ol className="space-y-4">
      {steps.map((step, index) => (
        <li key={step.title} className="flex gap-4">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand/15 text-sm font-semibold text-brand">
            {index + 1}
          </div>
          <div className="pt-0.5">
            <h3 className="text-sm font-semibold text-white">{step.title}</h3>
            <p className="mt-1 text-sm leading-6 text-slate-400">{step.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function DownloadCard({ item }: { item: DownloadItem }) {
  const Icon = item.icon;
  return (
    <a
      href={`${DOWNLOAD_ROOT}/${item.filename}`}
      download
      className={`group flex h-full flex-col rounded-2xl border p-5 transition ${
        item.primary
          ? 'border-brand/50 bg-brand/10 hover:border-brand'
          : 'border-white/10 bg-white/[0.035] hover:border-white/25 hover:bg-white/[0.055]'
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className={`grid h-10 w-10 place-items-center rounded-xl ${item.primary ? 'bg-brand text-white' : 'bg-white/10 text-slate-200'}`}>
          <Icon className="h-5 w-5" />
        </div>
        <Download className="h-4 w-4 text-slate-500 transition group-hover:translate-y-0.5 group-hover:text-white" />
      </div>
      <h3 className="mt-5 font-semibold text-white">{item.title}</h3>
      <p className="mt-2 flex-1 text-sm leading-6 text-slate-400">{item.description}</p>
      <code className="mt-4 block break-all text-[11px] text-slate-500">{item.filename}</code>
    </a>
  );
}

export default function AgentBuilderInstallPage() {
  return (
    <main className="min-h-screen overflow-hidden bg-[#090b11] text-slate-100">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[560px] bg-[radial-gradient(circle_at_50%_-20%,rgba(129,140,248,0.25),transparent_58%)]" />

      <header className="relative z-10 border-b border-white/10 bg-[#090b11]/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 sm:px-8">
          <Link href="/" className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand font-bold text-white">L</span>
            <span>
              <span className="block text-sm font-semibold">Lazyoffice AIOS</span>
              <span className="block text-[10px] tracking-wide text-slate-500">AGENT BUILDER</span>
            </span>
          </Link>
          <div className="flex items-center gap-2">
            <Link href="/login" className="rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:bg-white/5 hover:text-white">
              登入
            </Link>
            <Link href="/agent-builds" className="inline-flex items-center gap-2 rounded-lg bg-white px-3.5 py-2 text-sm font-medium text-slate-950 transition hover:bg-slate-200">
              查看建置紀錄 <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </header>

      <section className="relative mx-auto max-w-5xl px-5 pb-20 pt-20 text-center sm:px-8 sm:pt-28">
        <div className="mx-auto inline-flex items-center gap-2 rounded-full border border-brand/30 bg-brand/10 px-3 py-1.5 text-xs font-medium text-indigo-300">
          <Sparkles className="h-3.5 w-3.5" />
          在熟悉的 AI 裡，直接建立企業 AI 員工
        </div>
        <h1 className="mx-auto mt-7 max-w-4xl text-balance text-4xl font-semibold tracking-tight text-white sm:text-6xl">
          ChatGPT 與 Claude
          <span className="block bg-gradient-to-r from-indigo-300 via-violet-300 to-sky-300 bg-clip-text text-transparent">
            Agent Builder 安裝中心
          </span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-pretty text-base leading-7 text-slate-400 sm:text-lg">
          使用者只需要描述工作、上傳範本並回答幾個情境問題。AIOS 會保存對話，在背景建立 Agent、Skill、記憶、流程與測試草稿。
        </p>
        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <a href="#downloads" className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-5 py-3 text-sm font-semibold text-white transition hover:brightness-110 sm:w-auto">
            <Download className="h-4 w-4" /> 下載安裝檔
          </a>
          <a href="#guides" className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 px-5 py-3 text-sm font-medium transition hover:bg-white/10 sm:w-auto">
            查看安裝步驟 <ChevronRight className="h-4 w-4" />
          </a>
        </div>
      </section>

      <section className="relative mx-auto max-w-6xl px-5 pb-24 sm:px-8">
        <div className="grid overflow-hidden rounded-2xl border border-white/10 bg-white/[0.035] md:grid-cols-4">
          {[
            { icon: MessageSquareText, title: '自然對話', text: '動態理解需求，不走固定問卷' },
            { icon: RefreshCw, title: '背景迭代', text: '每輪持續更新完整草稿' },
            { icon: ShieldCheck, title: 'FDE 治理', text: '核准前不會正式生效' },
            { icon: Workflow, title: '真實測試', text: '測試資料、跨模型驗證與紀錄' },
          ].map(({ icon: Icon, title, text }, index) => (
            <div key={title} className={`p-6 ${index > 0 ? 'border-t border-white/10 md:border-l md:border-t-0' : ''}`}>
              <Icon className="h-5 w-5 text-indigo-300" />
              <div className="mt-3 text-sm font-semibold text-white">{title}</div>
              <div className="mt-1 text-xs leading-5 text-slate-500">{text}</div>
            </div>
          ))}
        </div>
      </section>

      <section id="guides" className="border-y border-white/10 bg-white/[0.02] py-24">
        <div className="mx-auto max-w-7xl px-5 sm:px-8">
          <div className="max-w-2xl">
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Installation guides</div>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white">選擇你使用的對話介面</h2>
            <p className="mt-4 text-sm leading-7 text-slate-400">
              兩種介面都連到同一個 AIOS 帳號與 Agent 建置紀錄。差別只在於客戶端如何保存每輪對話。
            </p>
          </div>

          <div className="mt-12 grid gap-6 lg:grid-cols-2">
            <article className="rounded-3xl border border-emerald-400/20 bg-emerald-400/[0.045] p-6 sm:p-8">
              <div className="flex items-center gap-4">
                <div className="grid h-12 w-12 place-items-center rounded-2xl bg-emerald-400/15 text-emerald-300"><Bot className="h-6 w-6" /></div>
                <div>
                  <div className="text-xs font-medium text-emerald-300">REMOTE MCP + SKILL</div>
                  <h2 className="mt-1 text-xl font-semibold text-white">ChatGPT／Codex</h2>
                </div>
              </div>
              <p className="mb-8 mt-5 text-sm leading-6 text-slate-400">
                ChatGPT 網頁沒有 Claude Code 的 Stop Hook，因此 Skill 會在重要回合顯示回答前，用 snapshot 工具同步對話與完整 Agent 草稿。
              </p>
              <StepList steps={chatGptSteps} />
            </article>

            <article className="rounded-3xl border border-orange-300/20 bg-orange-300/[0.04] p-6 sm:p-8">
              <div className="flex items-center gap-4">
                <div className="grid h-12 w-12 place-items-center rounded-2xl bg-orange-300/15 text-orange-200"><Code2 className="h-6 w-6" /></div>
                <div>
                  <div className="text-xs font-medium text-orange-200">PLUGIN + SKILL + HOOKS</div>
                  <h2 className="mt-1 text-xl font-semibold text-white">Claude／Claude Code</h2>
                </div>
              </div>
              <p className="mb-8 mt-5 text-sm leading-6 text-slate-400">
                Claude Code／Cowork 可透過 UserPromptSubmit 與 Stop Hooks 自動保存正常完成的回合；Claude Chat 則由 Skill 主動同步。
              </p>
              <StepList steps={claudeSteps} />
            </article>
          </div>

          <div className="mt-6 rounded-2xl border border-indigo-400/20 bg-indigo-400/[0.05] p-5 sm:flex sm:items-center sm:justify-between sm:gap-6">
            <div className="flex items-start gap-3">
              <Server className="mt-0.5 h-5 w-5 shrink-0 text-indigo-300" />
              <div>
                <div className="text-sm font-semibold text-white">唯一需要連線的 Remote MCP</div>
                <code className="mt-2 block break-all text-xs text-indigo-200">{REMOTE_MCP}</code>
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2 text-xs text-slate-400 sm:mt-0">
              <Cloud className="h-4 w-4 text-emerald-300" /> 中央服務 · OAuth · 無本機 Server
            </div>
          </div>
        </div>
      </section>

      <section id="downloads" className="mx-auto max-w-7xl px-5 py-24 sm:px-8">
        <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
          <div className="max-w-2xl">
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Downloads</div>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white">安裝檔與說明文件</h2>
            <p className="mt-4 text-sm leading-7 text-slate-400">
              網站建置時會從正式 MCP release 自動同步這些檔案；壓縮包不包含帳號、密碼、Token 或客戶端 AIOS Server。
            </p>
          </div>
          <a
            href={`${DOWNLOAD_ROOT}/manifest.json`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 text-sm text-slate-400 transition hover:text-white"
          >
            查看檔案 manifest <ChevronRight className="h-4 w-4" />
          </a>
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {downloads.map((item) => <DownloadCard key={item.filename} item={item} />)}
        </div>
      </section>

      <section className="border-t border-white/10 bg-white/[0.02] py-24">
        <div className="mx-auto grid max-w-7xl gap-10 px-5 sm:px-8 lg:grid-cols-[0.8fr_1.2fr]">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Security boundary</div>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white">安裝完成，不代表 Agent 已生效</h2>
            <p className="mt-5 text-sm leading-7 text-slate-400">
              外部 AI 只能建立 shadow draft。OAuth 連線固定使用 Agent Builder 的 MEMBER 權限，無法自行確認 Skill、核准權限或啟用正式 Agent。
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              { icon: LockKeyhole, text: 'Skill 永遠停在待 FDE 確認' },
              { icon: CircleUserRound, text: '每位使用者只看到自己的建置資料' },
              { icon: KeyRound, text: 'OAuth 不把帳號密碼放進安裝包' },
              { icon: ShieldCheck, text: '寄信、寫入與不可逆操作需人工核准' },
              { icon: CheckCircle2, text: '測試通過後仍需 FDE 最終啟用' },
              { icon: Cloud, text: '客戶端只連公開 HTTPS Remote MCP' },
            ].map(({ icon: Icon, text }) => (
              <div key={text} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.035] p-4 text-sm text-slate-300">
                <Icon className="h-4 w-4 shrink-0 text-emerald-300" /> {text}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-5 py-24 text-center sm:px-8">
        <h2 className="text-3xl font-semibold tracking-tight text-white">安裝後，直接說你想建立什麼員工</h2>
        <p className="mx-auto mt-4 max-w-xl text-sm leading-7 text-slate-400">
          你不需要先理解 Agent、Skill、MCP 或 Harness。AI 會用自然對話整理需求，AIOS 則負責版本、治理與測試。
        </p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <a href={`${DOWNLOAD_ROOT}/lazyoffice-aios-builder-plugin.zip`} download className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-5 py-3 text-sm font-semibold text-white hover:brightness-110">
            <Download className="h-4 w-4" /> 下載 Universal Plugin
          </a>
          <Link href="/agent-builds" className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/15 px-5 py-3 text-sm font-medium hover:bg-white/5">
            前往 Agent 建置紀錄 <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <footer className="border-t border-white/10 py-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-5 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <div className="flex items-center gap-2"><span className="grid h-6 w-6 place-items-center rounded-md bg-brand text-[10px] font-bold text-white">L</span> Lazyoffice AIOS Agent Builder</div>
          <div>Remote MCP · OAuth 2.1 · FDE governed</div>
        </div>
      </footer>
    </main>
  );
}
