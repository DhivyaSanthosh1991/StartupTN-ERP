'use client';

import { Fragment, useState } from 'react';
import { Empty, ErrorNote, Loading, PageHeader, Select, TableWrap, td, th } from '@/components/ui';
import { useApi } from '@/lib/api';
import { fmtDateTime } from '@/lib/dates';

interface Entry { id: number; actor_name: string | null; action: string; entity_type: string; entity_id: string | null; before_data: unknown; after_data: unknown; ip_address: string | null; created_at: string }

const TYPES = ['', 'employee', 'leave_request', 'od_request', 'regularisation_request', 'approval_request', 'delegation', 'document', 'department', 'holiday', 'notice', 'settings', 'geofence', 'leave_type', 'workflow'];

export default function AdminAuditPage() {
  const [type, setType] = useState('');
  const { data, error, loading, reload } = useApi<Entry[]>(`/admin/audit?limit=200${type ? `&entityType=${type}` : ''}`);
  const [open, setOpen] = useState<number | null>(null);

  return (
    <div>
      <PageHeader title="Audit log" description="Who changed what, newest first. Entries cannot be edited or deleted."
        actions={<Select value={type} onChange={(e) => setType(e.target.value)} className="w-48" aria-label="Kind of record">{TYPES.map((t) => <option key={t} value={t}>{t ? t.replace(/_/g, ' ') : 'All records'}</option>)}</Select>} />
      {loading && !data && <Loading />}
      {error && <ErrorNote error={error} retry={reload} />}
      {data?.length === 0 && <Empty title="Nothing logged" />}
      {data && data.length > 0 && (
        <TableWrap>
          <thead><tr><th className={th}>When</th><th className={th}>Who</th><th className={th}>What</th><th className={th}></th></tr></thead>
          <tbody>
            {data.map((e) => (
              <Fragment key={e.id}>
                <tr>
                  <td className={td}>{fmtDateTime(e.created_at)}</td>
                  <td className={td}>{e.actor_name ?? <span className="text-muted">System</span>}</td>
                  <td className={td}><span className="font-medium">{e.action}</span><span className="block text-xs text-muted">{e.entity_type}{e.entity_id ? ` · ${e.entity_id.slice(0, 8)}` : ''}</span></td>
                  <td className={td}>{(e.before_data || e.after_data) ? <button type="button" className="text-sm font-medium text-peacock hover:underline" onClick={() => setOpen(open === e.id ? null : e.id)}>{open === e.id ? 'Hide' : 'Details'}</button> : null}</td>
                </tr>
                {open === e.id && (
                  <tr><td colSpan={4} className="border-b border-line bg-wash/40 px-4 py-3">
                    <div className="grid gap-3 text-xs sm:grid-cols-2">
                      {e.before_data != null && <div><p className="mb-1 font-semibold text-muted">Before</p><pre className="overflow-x-auto whitespace-pre-wrap break-words">{JSON.stringify(e.before_data, null, 2)}</pre></div>}
                      {e.after_data != null && <div><p className="mb-1 font-semibold text-muted">After</p><pre className="overflow-x-auto whitespace-pre-wrap break-words">{JSON.stringify(e.after_data, null, 2)}</pre></div>}
                    </div>
                  </td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}
