'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Button, Field, Input, Notice, cx } from '@/components/ui';
import { api, errorText, useApi } from '@/lib/api';
import { LOGO_SIZE, LOGO_SRC } from '@/lib/logo';
import { useSession } from '@/lib/session';

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (o: { client_id: string; callback: (r: { credential: string }) => void; hd?: string; auto_select?: boolean }) => void;
          renderButton: (el: HTMLElement, o: Record<string, unknown>) => void;
        };
      };
    };
  }
}

interface AuthConfig { googleClientId: string; allowedDomain: string; devLogin: boolean }

export default function LoginPage() {
  const router = useRouter();
  const { me, loading, refresh } = useSession();
  const { data: config, error: configError, reload } = useApi<AuthConfig>('/auth/config');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const button = useRef<HTMLDivElement>(null);

  // The free server sleeps when idle and takes up to a minute to wake: keep trying quietly.
  useEffect(() => {
    if (!configError) return;
    const t = setTimeout(() => void reload(), 5000);
    return () => clearTimeout(t);
  }, [configError, reload]);

  useEffect(() => {
    if (!loading && me) router.replace('/');
  }, [loading, me, router]);

  const finish = async (path: string, body: unknown) => {
    setBusy(true);
    setError('');
    try {
      await api(path, { method: 'POST', body });
      await refresh();
      router.replace('/');
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  // Google's own sign-in button. The server checks the token, the domain and that HR has added the person.
  useEffect(() => {
    if (!config?.googleClientId || config.googleClientId.startsWith('your-')) return;
    const start = () => {
      if (!window.google || !button.current) return;
      window.google.accounts.id.initialize({
        client_id: config.googleClientId,
        hd: config.allowedDomain,
        callback: (r) => void finish('/auth/google', { idToken: r.credential }),
      });
      window.google.accounts.id.renderButton(button.current, { theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', width: 300 });
    };
    if (window.google) return start();
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = start;
    document.head.appendChild(script);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  const googleReady = !!config?.googleClientId && !config.googleClientId.startsWith('your-');

  return (
    <main className="mx-auto grid min-h-dvh max-w-5xl items-center gap-10 px-5 py-10 md:grid-cols-[1.1fr_1fr]">
      <div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={LOGO_SRC} alt="Government of Tamil Nadu emblem and StartupTN logo" width={LOGO_SIZE.width} height={LOGO_SIZE.height} className="h-auto w-72 max-w-full md:w-96" />
      </div>

      <div className="rounded-2xl border border-line bg-surface p-6 sm:p-8">
        <h2 className="font-display text-2xl font-semibold">Sign in</h2>
        <p className="mt-1 text-sm text-muted">{googleReady || !config?.devLogin ? <>Use your {config ? `@${config.allowedDomain}` : 'work'} Google account.</> : <>Enter your @{config.allowedDomain} work email.</>}</p>

        <div className="mt-5 space-y-4">
          {configError && <Notice tone="marigold">The portal is waking up. This can take up to a minute, and it will keep trying.</Notice>}
          {googleReady && <div ref={button} className={cx('min-h-11', busy && 'pointer-events-none opacity-50')} />}
          {config && !googleReady && !config.devLogin && <Notice tone="marigold">Google sign-in is not set up yet. Ask the administrator to add the Google client ID.</Notice>}
          {error && <Notice tone="kumkum">{error}</Notice>}
        </div>

        {config?.devLogin && (
          <form
            className={cx('space-y-3', googleReady ? 'mt-6 border-t border-line pt-5' : 'mt-5')}
            onSubmit={(e) => { e.preventDefault(); void finish('/auth/dev-login', { email: email.includes('@') ? email : `${email}@${config.allowedDomain}` }); }}
          >
            <Field label="Work email">
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={`name@${config.allowedDomain}`} autoComplete="email" required />
            </Field>
            <Button type="submit" busy={busy} className="w-full">Sign in</Button>
          </form>
        )}

        <p className="mt-6 text-xs text-muted">If your email is not recognised, ask HR to add you to the employee list.</p>
      </div>
    </main>
  );
}
