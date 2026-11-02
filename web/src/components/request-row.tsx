'use client';

import { Badge, StatusBadge } from './ui';

/** One request in a list: what it is, who has it now, and what can be done. Shared by leave, on-duty and corrections. */
export function RequestRow({ title, meta, status, approver, comment, who, actions, onOpen }: {
  title: string;
  meta?: string;
  status: string;
  approver?: string | null;
  comment?: string | null;
  who?: string;
  actions?: React.ReactNode;
  onOpen?: () => void;
}) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        {who && <p className="text-sm font-medium">{who}</p>}
        <p className={who ? 'text-sm' : 'font-medium'}>{title}</p>
        {meta && <p className="mt-0.5 text-sm text-muted">{meta}</p>}
        {status === 'pending' && approver && <p className="mt-0.5 text-sm text-muted">With {approver}</p>}
        {comment && status !== 'pending' && <p className="mt-0.5 text-sm text-muted">“{comment}”</p>}
        {onOpen && <button type="button" onClick={onOpen} className="mt-1 text-xs font-medium text-peacock hover:underline">See who has approved</button>}
      </div>
      <div className="flex items-center gap-2">
        <StatusBadge status={status} />
        {actions}
      </div>
    </li>
  );
}

export function KindBadge({ children }: { children: React.ReactNode }) {
  return <Badge tone="indigo">{children}</Badge>;
}
