'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { Spinner } from '@/components/ui';

/**
 * Root entry: after auth loads, everyone goes to the Agent Workbench (`/work`).
 * FDE manage surface lives at `/admin` (and existing /employees, /skills, …).
 */
export default function RootRedirectPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace('/login');
      return;
    }
    router.replace('/work');
  }, [loading, user, router]);

  return (
    <div className="flex h-screen items-center justify-center">
      <Spinner className="h-6 w-6" />
    </div>
  );
}
