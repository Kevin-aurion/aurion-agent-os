import type { HTMLAttributes, ReactNode } from 'react';
import { AlertCircle, CheckCircle2, LoaderCircle, ShieldCheck } from 'lucide-react';
import { statusTone, type Tone } from '@/lib/presentation';

export function Badge({
  children,
  tone = 'neutral',
  className,
  ...rest
}: {
  children: ReactNode;
  tone?: Tone;
} & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={['badge', `badge-${tone}`, className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status?: string | null }) {
  return <Badge tone={statusTone(status)}>{status || '未設定'}</Badge>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description: string; actions?: ReactNode }) {
  return <header className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-description">{description}</p></div>{actions && <div className="page-actions">{actions}</div>}</header>;
}

export function Section({ title, description, children, actions, className = '' }: { title: string; description?: string; children: ReactNode; actions?: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}><div className="section-heading"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{actions}</div>{children}</section>;
}

export function SettingRow({ icon, title, description, children }: { icon?: ReactNode; title: string; description: string; children: ReactNode }) {
  return <div className="setting-row"><div className="setting-copy">{icon && <span className="setting-icon">{icon}</span>}<div><h3>{title}</h3><p>{description}</p></div></div><div className="setting-control">{children}</div></div>;
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return <div className="empty-state"><div className="empty-icon"><ShieldCheck size={22} /></div><h3>{title}</h3><p>{description}</p></div>;
}

export function LoadingState({ label = '正在同步資料' }: { label?: string }) {
  return <div className="inline-state"><LoaderCircle className="spin" size={18} /><span>{label}</span></div>;
}

export function ErrorState({ message }: { message: string }) {
  return <div className="notice notice-danger"><AlertCircle size={18} /><span>{message}</span></div>;
}

export function GateNotice({ children }: { children: ReactNode }) {
  return <div className="notice notice-governance"><CheckCircle2 size={18} /><div>{children}</div></div>;
}

export function Metric({ label, value, hint, tone = 'neutral' }: { label: string; value: ReactNode; hint: string; tone?: Tone }) {
  return <div className={`metric metric-${tone}`}><p>{label}</p><strong>{value}</strong><span>{hint}</span></div>;
}

export function Disclosure({ title, description, children, defaultOpen = false }: { title: string; description: string; children: ReactNode; defaultOpen?: boolean }) {
  return <details className="disclosure" open={defaultOpen}><summary><span><strong>{title}</strong><small>{description}</small></span></summary><div className="disclosure-body">{children}</div></details>;
}
