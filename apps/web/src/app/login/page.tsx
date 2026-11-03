'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Button, Field, Input, Notice, cx } from '@/components/ui';
import { api, errorText, useApi } from '@/lib/api';
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

const DEMO_PEOPLE = ['priya', 'ravi', 'mani', 'hari', 'hema', 'meena', 'sathya'];

export default function LoginPage() {
  const router = useRouter();
  const { me, loading, refresh } = useSession();
  const { data: config, error: configError } = useApi<AuthConfig>('/auth/config');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const button = useRef<HTMLDivElement>(null);

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
        <p className="font-display text-3xl font-semibold tracking-tight">StartupTN<span className="text-marigold">.</span></p>
        <h1 className="mt-8 font-display text-4xl font-semibold leading-tight tracking-tight md:text-5xl">Check in, apply for leave, get approvals done.</h1>
        <p className="mt-4 max-w-md text-muted">The staff portal for attendance, leave, on-duty requests and your employee records.</p>
      </div>

      <div className="rounded-2xl border border-line bg-surface p-6 sm:p-8">
        <h2 className="font-display text-2xl font-semibold">Sign in</h2>
        <p className="mt-1 text-sm text-muted">Use your {config ? `@${config.allowedDomain}` : 'work'} Google account.</p>

        <div className="mt-5 space-y-4">
          {configError && <Notice tone="kumkum">The portal could not reach its server. Check your connection and reload.</Notice>}
          {googleReady && <div ref={button} className={cx('min-h-11', busy && 'pointer-events-none opacity-50')} />}
          {config && !googleReady && !config.devLogin && <Notice tone="marigold">Google sign-in is not set up yet. Ask the administrator to add the Google client ID.</Notice>}
          {error && <Notice tone="kumkum">{error}</Notice>}
        </div>

        {config?.devLogin && (
          <form
            className="mt-6 space-y-3 border-t border-line pt-5"
            onSubmit={(e) => { e.preventDefault(); void finish('/auth/dev-login', { email: email.includes('@') ? email : `${email}@${config.allowedDomain}` }); }}
          >
            <p className="text-sm font-medium">Test sign-in <span className="font-normal text-muted">(development only)</span></p>
            <Field label="Work email or first name">
              <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="priya" autoComplete="off" required />
            </Field>
            <div className="flex flex-wrap gap-1.5">
              {DEMO_PEOPLE.map((p) => (
                <button key={p} type="button" onClick={() => setEmail(p)} className="rounded-full border border-line px-3 py-1 text-xs hover:bg-wash">{p}</button>
              ))}
            </div>
            <Button type="submit" busy={busy} className="w-full">Sign in as this person</Button>
          </form>
        )}

        <p className="mt-6 text-xs text-muted">If you are told your account is not registered, ask HR to add you to the employee list first.</p>
      </div>
    </main>
  );
}
