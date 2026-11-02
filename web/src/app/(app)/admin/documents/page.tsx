'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Badge, Empty, ErrorNote, Loading, PageHeader, Select, TableWrap, td, th } from '@/components/ui';
import { useApi } from '@/lib/api';
import { fmtDate } from '@/lib/dates';
import type { DocumentView } from '@/lib/types';

export default function AdminDocumentsPage() {
  const [days, setDays] = useState(30);
  const { data, error, loading, reload } = useApi<DocumentView[]>(`/admin/documents/expiring?days=${days}`);
  return (
    <div>
      <PageHeader title="Documents due" description="Contracts and certificates that have expired or are about to, across all staff."
        actions={<Select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Look ahead" className="w-48">
          <option value={30}>Expired, or within 30 days</option><option value={60}>Within 60 days</option><option value={90}>Within 90 days</option><option value={180}>Within 6 months</option>
        </Select>} />
      {loading && !data && <Loading />}
      {error && <ErrorNote error={error} retry={reload} />}
      {data?.length === 0 && <Empty title="Nothing is due">No tracked document expires in this period.</Empty>}
      {data && data.length > 0 && (
        <TableWrap>
          <thead><tr><th className={th}>Employee</th><th className={th}>Document</th><th className={th}>Type</th><th className={th}>Valid until</th></tr></thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.id}>
                <td className={td}><Link href={`/people/${d.employeeId}?tab=documents`} className="font-medium hover:underline">{d.employeeName}</Link><p className="text-xs text-muted">{d.empCode}</p></td>
                <td className={td}>{d.title}{d.visibility === 'hr_only' && <> <Badge tone="indigo">HR only</Badge></>}</td>
                <td className={td}>{d.category.name}</td>
                <td className={td}>{fmtDate(d.expiresOn!)} <Badge tone={d.expiry === 'expired' ? 'kumkum' : 'marigold'}>{d.expiry === 'expired' ? 'Expired' : 'Due soon'}</Badge></td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}
