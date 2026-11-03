import type { LeaveBalance } from '@/lib/types';
import { Panel } from './ui';

export function BalanceRow({ b }: { b: LeaveBalance }) {
  const share = b.entitlement > 0 ? Math.min((b.used + b.pending) / b.entitlement, 1) : 0;
  return (
    <div className="px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium">{b.name}</span>
        {b.unlimited
          ? <span className="text-sm text-muted">Unpaid · {b.used > 0 ? `${b.used} taken` : 'no limit'}</span>
          : <span><span className="font-display text-xl font-semibold">{b.available}</span><span className="text-sm text-muted"> available</span></span>}
      </div>
      {!b.unlimited && (
        <>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-wash" aria-hidden="true">
            <div className="h-full rounded-full bg-peacock" style={{ width: `${share * 100}%` }} />
          </div>
          <p className="mt-1.5 text-xs text-muted">
            {b.event ? `${b.used} taken · up to ${b.entitlement} days at a time` : `${b.used} used${b.pending > 0 ? `, ${b.pending} waiting for approval` : ''} · ${b.entitlement} this year`}
          </p>
          {!!b.carriedOver && b.carriedOverUntil && (
            <p className="mt-0.5 text-xs text-muted">Includes {b.carriedOver} from last year, used first, until {new Date(`${b.carriedOverUntil}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}.</p>
          )}
        </>
      )}
    </div>
  );
}

export function BalanceList({ balances }: { balances: LeaveBalance[] }) {
  return (
    <Panel className="divide-y divide-line">
      {balances.length === 0 && <p className="p-4 text-sm text-muted">No leave types apply yet. Ask HR.</p>}
      {balances.map((b) => <BalanceRow key={b.leaveTypeId} b={b} />)}
    </Panel>
  );
}
