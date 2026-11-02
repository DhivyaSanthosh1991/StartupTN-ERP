'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Icon } from './icons';

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

// ------------------------------------------------------------------ buttons

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'md' | 'sm' | 'lg';
  busy?: boolean;
};

const BUTTON_BASE = 'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-55';
const BUTTON_VARIANT = {
  primary: 'bg-peacock text-white hover:bg-peacock-dark',
  secondary: 'border border-line bg-surface text-ink hover:bg-wash',
  danger: 'border border-kumkum/40 bg-surface text-kumkum hover:bg-kumkum-tint',
  ghost: 'text-peacock hover:bg-peacock-tint',
};
const BUTTON_SIZE = { sm: 'h-8 px-3 text-sm', md: 'h-10 px-4 text-sm', lg: 'h-12 px-6 text-base' };

export function Button({ variant = 'primary', size = 'md', busy, disabled, className, children, ...rest }: ButtonProps) {
  return (
    <button type="button" {...rest} disabled={disabled || busy} aria-busy={busy || undefined} className={cx(BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SIZE[size], className)}>
      {busy && <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />}
      {children}
    </button>
  );
}

// -------------------------------------------------------------------- forms

// Full width unless the caller sets its own width ("w-28"): two width utilities on one element
// are resolved by stylesheet order, not class order, so the default is only added when needed.
const fieldWidth = (className?: string) => (className && /(^|\s)w-/.test(className) ? '' : 'w-full');

export const inputClass =
  'block rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted/70 focus:border-peacock focus:outline-none focus:ring-2 focus:ring-peacock/25 disabled:bg-wash disabled:text-muted';

export function Field({ label, hint, error, children, className }: { label: string; hint?: string; error?: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-muted">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-kumkum">{error}</span>}
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputClass, fieldWidth(props.className), props.className)} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(inputClass, fieldWidth(props.className), 'pr-8', props.className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={3} {...props} className={cx(inputClass, fieldWidth(props.className), props.className)} />;
}

export function Check({ label, ...rest }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" {...rest} className="size-4 rounded border-line accent-peacock" />
      {label}
    </label>
  );
}

// ------------------------------------------------------------------- badges

export type Tone = 'peacock' | 'marigold' | 'kumkum' | 'indigo' | 'neutral';
const TONE: Record<Tone, string> = {
  peacock: 'bg-peacock-tint text-peacock-dark',
  marigold: 'bg-marigold-tint text-marigold-ink',
  kumkum: 'bg-kumkum-tint text-kumkum',
  indigo: 'bg-indigo-tint text-indigo',
  neutral: 'bg-wash text-muted',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium', TONE[tone], className)}>{children}</span>;
}

const REQUEST_STATUS: Record<string, [Tone, string]> = {
  pending: ['marigold', 'Waiting'],
  approved: ['peacock', 'Approved'],
  rejected: ['kumkum', 'Declined'],
  cancelled: ['neutral', 'Cancelled'],
};

export function StatusBadge({ status }: { status: string }) {
  const [tone, label] = REQUEST_STATUS[status] ?? ['neutral', status];
  return <Badge tone={tone}>{label}</Badge>;
}

// ------------------------------------------------------------------- layout

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-display text-3xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-prose text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Section({ title, action, children, className }: { title?: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cx('mb-8', className)}>
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title && <h2 className="font-display text-xl font-semibold">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/** A bordered surface for content that belongs together. */
export function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cx('rounded-xl border border-line bg-surface', className)}>{children}</div>;
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-3 py-8 text-muted">
      <span className="size-5 animate-spin rounded-full border-2 border-peacock border-t-transparent" aria-hidden="true" />
      {label}…
    </div>
  );
}

export function ErrorNote({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-kumkum/30 bg-kumkum-tint px-4 py-3 text-sm text-kumkum">
      <Icon name="alert" className="size-5 shrink-0" />
      <span className="min-w-0 flex-1">{message}</span>
      {retry && <Button variant="danger" size="sm" onClick={retry}>Try again</Button>}
    </div>
  );
}

export function Notice({ tone = 'marigold', children }: { tone?: 'marigold' | 'kumkum' | 'peacock' | 'indigo'; children: React.ReactNode }) {
  return <div role={tone === 'kumkum' ? 'alert' : 'status'} className={cx('rounded-lg px-3 py-2 text-sm', TONE[tone])}>{children}</div>;
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('');
  return <span aria-hidden="true" className={cx('inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-peacock-tint text-sm font-semibold text-peacock-dark', className)}>{initials}</span>;
}

// --------------------------------------------------------------------- tabs

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div role="tablist" className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            '-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
            value === t.id ? 'border-peacock text-peacock-dark' : 'border-transparent text-muted hover:text-ink',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------- dialog

export function Dialog({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      aria-label={title}
      className={cx('m-auto w-[calc(100%-2rem)] rounded-2xl border border-line bg-surface p-0 text-ink shadow-xl', wide ? 'max-w-2xl' : 'max-w-md')}
    >
      {open && (
        <div className="max-h-[85dvh] overflow-y-auto p-5 sm:p-6">
          <div className="mb-4 flex items-start justify-between gap-4">
            <h2 className="font-display text-xl font-semibold">{title}</h2>
            <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded-lg p-1 text-muted hover:bg-wash hover:text-ink">
              <Icon name="close" />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

export function FormActions({ children }: { children: React.ReactNode }) {
  return <div className="mt-5 flex flex-wrap justify-end gap-2">{children}</div>;
}

// -------------------------------------------------------------------- toasts

type ToastTone = 'success' | 'error';
const ToastContext = createContext<(message: string, tone?: ToastTone) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<{ id: number; message: string; tone: ToastTone }[]>([]);
  const next = useRef(1);
  const push = useCallback((message: string, tone: ToastTone = 'success') => {
    const id = next.current++;
    setItems((list) => [...list, { id, message, tone }]);
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), tone === 'error' ? 8000 : 4500);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 md:bottom-6">
        {items.map((t) => (
          <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'}
            className={cx('pointer-events-auto max-w-md rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg', t.tone === 'error' ? 'bg-kumkum text-white' : 'bg-ink text-white')}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// -------------------------------------------------------------------- tables

/** Rows as a plain list on small screens and a table on wide ones is more work than it is worth here: scroll sideways instead. */
export function TableWrap({ children }: { children: React.ReactNode }) {
  return <div className="overflow-x-auto rounded-xl border border-line bg-surface"><table className="w-full min-w-[34rem] text-left text-sm [&_tbody_tr:last-child_td]:border-b-0">{children}</table></div>;
}
export const th = 'border-b border-line bg-wash/60 px-4 py-2.5 text-xs font-semibold text-muted';
export const td = 'border-b border-line/70 px-4 py-3 align-middle';
