'use client';

import { errorText, useApi } from '@/lib/api';
import { fmtDateTime } from '@/lib/dates';
import { REQUEST_TYPE_LABEL, ROLE_LABEL } from '@/lib/labels';
import { Badge, Dialog, Loading, StatusBadge, cx } from './ui';

interface Trail {
  id: string; type: string; status: string; summary: string; requester: { id: string; fullName: string };
  createdAt: string; completedAt: string | null;
  steps: { order: number; status: string; approverName: string | null; approverRole: string | null; actedByName: string | null; actedAt: string | null; comment: string | null; dueAt: string | null }[];
}

const STEP: Record<string, string> = { pending: 'Waiting', approved: 'Approved', rejected: 'Declined', skipped: 'Not needed', cancelled: 'Cancelled', waiting: 'Not started' };

/** The path a request takes and where it stands. */
export function ApprovalTrail({ approvalRequestId, onClose }: { approvalRequestId: string | null; onClose: () => void }) {
  const { data, error, loading } = useApi<Trail>(approvalRequestId ? `/approvals/${approvalRequestId}` : null);
  return (
    <Dialog open={!!approvalRequestId} onClose={onClose} title="Approval trail" wide>
      {loading && !data && <Loading />}
      {error && <p className="text-sm text-kumkum">{errorText(error)}</p>}
      {data && (
        <div className="space-y-4">
          <div>
            <p className="flex flex-wrap items-center gap-2"><Badge tone="indigo">{REQUEST_TYPE_LABEL[data.type] ?? data.type}</Badge><StatusBadge status={data.status} /></p>
            <p className="mt-2 font-medium">{data.requester.fullName}</p>
            <p className="text-sm text-muted">{data.summary}</p>
            <p className="mt-1 text-xs text-muted">Sent {fmtDateTime(data.createdAt)}</p>
          </div>
          <ol className="space-y-3 border-l-2 border-line pl-4">
            {data.steps.filter((s) => s.status !== 'skipped').map((s) => (
              <li key={s.order} className="relative">
                <span className={cx('absolute -left-[23px] top-1.5 size-3 rounded-full border-2 border-surface',
                  s.status === 'approved' ? 'bg-peacock' : s.status === 'rejected' ? 'bg-kumkum' : s.status === 'pending' ? 'bg-marigold' : 'bg-line')} />
                <p className="text-sm">
                  <span className="font-medium">{s.actedByName ?? s.approverName ?? (s.approverRole ? `Anyone with the ${ROLE_LABEL[s.approverRole] ?? s.approverRole} role` : 'Approver')}</span>
                  <span className="text-muted"> · {STEP[s.status] ?? s.status}{s.actedAt ? `, ${fmtDateTime(s.actedAt)}` : ''}</span>
                </p>
                {s.comment && <p className="text-sm text-muted">“{s.comment}”</p>}
                {s.status === 'pending' && s.dueAt && <p className="text-xs text-muted">Reply due {fmtDateTime(s.dueAt)}</p>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </Dialog>
  );
}
