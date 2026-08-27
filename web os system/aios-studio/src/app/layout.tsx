import type { Metadata } from 'next';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Aurion AIOS Studio',
  description: 'AI 員工、模型、工具、知識、技能與部署的企業控制中心',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-Hant"><body><Providers>{children}</Providers></body></html>;
}
