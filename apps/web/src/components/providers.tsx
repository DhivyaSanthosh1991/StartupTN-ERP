'use client';

import { SessionProvider } from '@/lib/session';
import { ToastProvider } from './ui';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <SessionProvider>{children}</SessionProvider>
    </ToastProvider>
  );
}
