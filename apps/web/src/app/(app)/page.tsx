'use client';

import Link from 'next/link';
import { BalanceRow } from '@/components/balances';
import { BreakCard } from '@/components/break-card';
import { DutyCard } from '@/components/duty-card';
import { PunchPanel } from '@/components/punch';
import { Badge, ErrorNote, Loading, Notice, Panel, Section, cx } from '@/components/ui';
import { useApi } from '@/lib/api';
import { fmtDate, fmtDay, fmtHm, fmtMinutes, fmtRange, relative } from '@/lib/dates';
import { DAY_PART } from '@/lib/labels';
import { useMe } from '@/lib/session';
import type { Dashboard } from '@/lib/types';
import { useState } from 'react';

function greeting(): string {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(new Date()));
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

export default function HomePage() {
  const me = useMe();
  const { data, error, loading, reload } = useApi<Dashboard>('/dashboard');
  const [today, setToday] = useState<Dashboard['attendance'] | null>(null);

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorNote error={error} retry={reload} />;
  if (!data) return null;

  const attendance = today ?? data.attendance;
  const { approvals, myRequests, team } = data;
  const firstName = me.fullName.split(' ')[0];
  const pendingParts = [
    myRequests.pending.leave && `${myRequests.pending.leave} leave`,
    myRequests.pending.od && `${myRequests.pending.od} on duty`,
    myRequests.pending.permission && `${myRequests.pending.permission} permission`,
    myRequests.pending.regularisation && `${myRequests.pending.regularisation} correction`,
  ].filter(Boolean);

  return (
    <div>
      <header className="mb-6">
        <h1 className="font-display text-3xl font-semibold tracking-tight">{greeting()}, {firstName}</h1>
        <p className="mt-1 text-muted">{fmtDay(data.date)} · {me.designation ?? 'Staff'}{me.departmentName && !me.designation?.includes(me.departmentName) ? `, ${me.departmentName}` : ''}</p>
      </header>

      <PunchPanel today={attendance} onChange={(t) => { setToday(t); void reload(); }} />
      <BreakCard today={attendance} />
      {attendance.info.od && <DutyCard refreshKey={`${attendance.events.length}`} />}

      <div className="mt-5 space-y-2">
        {approvals.waiting > 0 && (
          <Link href="/approvals" className="flex items-center justify-between gap-3 rounded-xl bg-marigold-tint px-4 py-3 text-marigold-ink hover:brightness-95">
            <span>
              <strong>{approvals.waiting} {approvals.waiting === 1 ? 'request is' : 'requests are'} waiting for you.</strong>{' '}
              {approvals.overdue > 0 && <span>{approvals.overdue} past the time limit.</span>}
            </span>
            <span className="text-sm font-medium underline">Review</span>
          </Link>
        )}
        {data.expiringDocuments.length > 0 && (
          <Link href={`/people/${me.id}?tab=documents`} className="block rounded-xl bg-marigold-tint px-4 py-3 text-marigold-ink hover:brightness-95">
            <strong>{data.expiringDocuments.length === 1 ? '1 document' : `${data.expiringDocuments.length} documents`} on your record {data.expiringDocuments.some((d) => d.expiry === 'expired') ? 'expired or ' : ''}expire soon.</strong>{' '}
            <span className="text-sm underline">{data.expiringDocuments[0].title}, {fmtDate(data.expiringDocuments[0].expiresOn!)}</span>
          </Link>
        )}
        {myRequests.pending.total > 0 && (
          <p className="px-1 text-sm text-muted">
            You have {myRequests.pending.total} {myRequests.pending.total === 1 ? 'request' : 'requests'} waiting for approval
            {pendingParts.length > 1 ? ` (${pendingParts.join(', ')})` : ''}.
          </p>
        )}
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[1.35fr_1fr]">
        <div>
          <Section title="Leave balance" action={<Link href="/leave" className="text-sm font-medium text-peacock hover:underline">Apply for leave</Link>}>
            <Panel className="divide-y divide-line">
              {data.leaveBalances.length === 0 && <p className="p-4 text-sm text-muted">No leave types apply to you yet. Ask HR.</p>}
              {data.leaveBalances.map((b) => <BalanceRow key={b.leaveTypeId} b={b} />)}
            </Panel>
          </Section>

          {team && (
            <Section title="Your team today">
              <Panel className="grid grid-cols-2 divide-x divide-y divide-line sm:grid-cols-4 sm:divide-y-0">
                <Stat label="In today" value={team.present} sub={team.checkedInNow ? `${team.checkedInNow} still in` : undefined} />
                <Stat label="Not in yet" value={team.notYetIn} />
                <Stat label="On leave" value={team.onLeave} />
                <Stat label="On duty" value={team.onDuty} />
              </Panel>
              <p className="mt-2 text-sm text-muted">
                {team.total} {team.total === 1 ? 'person' : 'people'}{team.dayOff ? `, ${team.dayOff} on a day off` : ''}.{' '}
                <Link href="/attendance?tab=team" className="font-medium text-peacock hover:underline">See who is where</Link>
              </p>
            </Section>
          )}

          {data.awayToday.length > 0 && (
            <Section title="Away today">
              <Panel className="divide-y divide-line">
                {data.awayToday.map((a) => (
                  <div key={a.employeeId} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                    <span><span className="font-medium">{a.fullName}</span>{a.designation && <span className="text-muted"> · {a.designation}</span>}</span>
                    <Badge tone="indigo">{a.away === 'od' ? 'On duty' : a.dayPart === 'full' ? 'On leave' : `On leave, ${DAY_PART[a.dayPart].toLowerCase()}`}</Badge>
                  </div>
                ))}
              </Panel>
            </Section>
          )}
        </div>

        <div>
          <Section title={`This month`} action={<Link href="/attendance" className="text-sm font-medium text-peacock hover:underline">Details</Link>}>
            <Panel className="divide-y divide-line">
              <Row label="Present" value={data.month.summary.present + data.month.summary.halfDay * 0.5} suffix={data.month.summary.halfDay ? `incl. ${data.month.summary.halfDay} half` : undefined} />
              <Row label="Late arrivals" value={data.month.summary.late} warn={data.month.summary.late > 3} />
              <Row label="Leave and on duty" value={data.month.summary.leave + data.month.summary.od} />
              <Row label="Absent" value={data.month.summary.absent} warn={data.month.summary.absent > 0} />
              <Row label="Hours worked" text={fmtMinutes(data.month.summary.workedMinutes)} />
            </Panel>
            {data.month.summary.missingCheckout > 0 && (
              <div className="mt-3"><Notice>{data.month.summary.missingCheckout} {data.month.summary.missingCheckout === 1 ? 'day has' : 'days have'} no check-out. <Link href="/attendance?tab=corrections" className="font-medium underline">Ask for a correction</Link></Notice></div>
            )}
          </Section>

          <Section title="Coming up">
            {myRequests.upcoming.length === 0 && data.holidays.length === 0 && <p className="text-sm text-muted">Nothing planned.</p>}
            <Panel className={cx('divide-y divide-line', myRequests.upcoming.length === 0 && data.holidays.length === 0 && 'hidden')}>
              {myRequests.upcoming.map((u) => (
                <div key={`${u.kind}-${u.id}`} className="px-4 py-2.5 text-sm">
                  <p className="font-medium">{fmtRange(u.from, u.to)}</p>
                  <p className="text-muted">
                    {u.kind === 'leave' ? `${u.label}${u.dayPart !== 'full' ? `, ${DAY_PART[u.dayPart].toLowerCase()}` : ''}` : u.kind === 'permission' ? `Permission ${fmtHm(u.fromTime!)}–${fmtHm(u.toTime!)}` : `On duty, ${u.label}`}
                  </p>
                </div>
              ))}
              {data.holidays.map((h) => (
                <div key={h.date} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <span><span className="font-medium">{fmtDay(h.date)}</span> <span className="text-muted">{h.name}</span></span>
                  {h.optional && <Badge>Optional</Badge>}
                </div>
              ))}
            </Panel>
          </Section>
        </div>
      </div>

      {data.notices.length > 0 && (
        <Section title="Notices" action={<Link href="/calendar" className="text-sm font-medium text-peacock hover:underline">All notices</Link>}>
          <div className="space-y-3">
            {data.notices.slice(0, 3).map((n) => (
              <article key={n.id} className="rounded-xl border border-line bg-surface p-4">
                <h3 className="font-medium">{n.title}</h3>
                <p className="mt-1 line-clamp-3 whitespace-pre-line text-sm text-muted">{n.body}</p>
                <p className="mt-2 text-xs text-muted">{relative(n.published_at)}{n.author ? ` · ${n.author}` : ''}</p>
              </article>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="px-4 py-3">
      <p className="font-display text-3xl font-semibold leading-none">{value}</p>
      <p className="mt-1.5 text-sm text-muted">{label}</p>
      {sub && <p className="text-xs text-muted">{sub}</p>}
    </div>
  );
}

function Row({ label, value, text, suffix, warn }: { label: string; value?: number; text?: string; suffix?: string; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-sm">
      <span className="text-muted">{label}</span>
      <span className={cx('font-medium', warn && 'text-kumkum')}>
        {text ?? value}{suffix && <span className="ml-1.5 text-xs font-normal text-muted">{suffix}</span>}
      </span>
    </div>
  );
}
