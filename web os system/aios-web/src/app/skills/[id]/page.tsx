'use client';

import { useParams } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { SkillGovernancePanel } from '@/components/admin/SkillGovernancePanel';

/**
 * FDE Skill 治理頁：版本歷史 / Diff / 發布閘 / 評測證據 / 回滾。
 * 角色閘由 AppShell（MEMBER → /work）+ 後端 requireTrainer 雙重把關。
 */
export default function SkillGovernancePage() {
  const params = useParams();
  const raw = params?.id;
  const skillId = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] ?? '' : '';

  return (
    <AppShell>
      <SkillGovernancePanel skillId={skillId} />
    </AppShell>
  );
}
