'use client';

import { useState } from 'react';
import { Badge, Empty, ErrorNote, Loading, PageHeader, Panel, Section, Select } from '@/components/ui';
import { useApi } from '@/lib/api';
import { fmtDay, fmtDate, relative, todayIst } from '@/lib/dates';

interface Holiday { id: string; date: string; name: string; optional: boolean }
interface Notice { id: string; title: string; body: string; published_at: string; expires_on: string | null; author: string | null }

export default function CalendarPage() {
  const thisYear = Number(todayIst().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const holidays = useApi<Holiday[]>(`/holidays?year=${year}`);
  const notices = useApi<Notice[]>('/notices');
  const today = todayIst();

  return (
    <div>
      <PageHeader title="Holidays and notices" description="The office holiday list and announcements from HR and management." />

      <Section title="Notices">
        {notices.loading && !notices.data && <Loading />}
        {notices.error && <ErrorNote error={notices.error} retry={notices.reload} />}
        {notices.data?.length === 0 && <Empty title="No notices right now" />}
        <div className="space-y-3">
          {notices.data?.map((n) => (
            <article key={n.id} className="rounded-xl border border-line bg-surface p-4">
              <h3 className="font-medium">{n.title}</h3>
              <p className="mt-1 whitespace-pre-line text-sm">{n.body}</p>
              <p className="mt-2 text-xs text-muted">{relative(n.published_at)}{n.author ? ` · ${n.author}` : ''}{n.expires_on ? ` · until ${fmtDate(n.expires_on)}` : ''}</p>
            </article>
          ))}
        </div>
      </Section>

      <Section title="Holidays" action={
        <Select value={year} onChange={(e) => setYear(Number(e.target.value))} className="w-28" aria-label="Year">
          {[thisYear - 1, thisYear, thisYear + 1].map((y) => <option key={y} value={y}>{y}</option>)}
        </Select>}>
        {holidays.loading && !holidays.data && <Loading />}
        {holidays.error && <ErrorNote error={holidays.error} retry={holidays.reload} />}
        {holidays.data?.length === 0 && <Empty title={`No holidays listed for ${year}`}>HR has not added the list yet.</Empty>}
        {holidays.data && holidays.data.length > 0 && (
          <Panel><ul className="divide-y divide-line">
            {holidays.data.map((h) => (
              <li key={h.id} className={`flex items-center justify-between gap-3 px-4 py-2.5 text-sm ${h.date < today ? 'text-muted' : ''}`}>
                <span><span className="font-medium">{fmtDay(h.date)}</span> <span>{h.name}</span></span>
                <span className="flex gap-1.5">{h.optional && <Badge>Optional</Badge>}{h.date === today && <Badge tone="peacock">Today</Badge>}</span>
              </li>
            ))}
          </ul></Panel>
        )}
      </Section>
    </div>
  );
}
