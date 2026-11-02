'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { BalanceList } from '@/components/balances';
import { DocumentsPanel } from '@/components/documents';
import { MonthCalendar } from '@/components/month-calendar';
import { Avatar, Badge, ErrorNote, Loading, Notice, Panel, Tabs } from '@/components/ui';
import { ApiError, useApi } from '@/lib/api';
import { fmtDate, monthOf, todayIst } from '@/lib/dates';
import { EMPLOYMENT_TYPE, ROLE_LABEL } from '@/lib/labels';
import { useSession } from '@/lib/session';
import type { DirectoryPerson, EmployeeProfile, LeaveBalance } from '@/lib/types';
import { useTab } from '@/lib/use-tab';

type TabId = 'details' | 'attendance' | 'leave' | 'documents';

export default function ProfilePage() {
  const { id } = useParams<{ id: string }>();
  const { me, isHr } = useSession();
  const detail = useApi<EmployeeProfile>(`/employees/${id}`);
  const directory = useApi<DirectoryPerson[]>('/employees/directory');
  const [tab, setTab] = useTab<TabId>(['details', 'attendance', 'leave', 'documents'], 'details');
  const [month, setMonth] = useState(monthOf(todayIst()));

  const person: DirectoryPerson | undefined = detail.data ?? directory.data?.find((p) => p.id === id);
  const full = detail.data;
  const own = me?.id === id;
  // Colleagues outside the reporting line see the basics only; the full record answers 403.
  const restricted = detail.error instanceof ApiError && detail.error.status === 403;

  if ((detail.loading && !detail.data) || (directory.loading && !person)) return <Loading />;
  if (!person) return <ErrorNote error={detail.error ?? new Error('This person was not found.')} retry={detail.reload} />;

  const tabs: { id: TabId; label: string }[] = [
    { id: 'details', label: 'Details' },
    ...(full ? [{ id: 'attendance' as const, label: 'Attendance' }, { id: 'leave' as const, label: 'Leave' }] : []),
    ...(own || isHr ? [{ id: 'documents' as const, label: 'Documents' }] : []),
  ];
  const active = tabs.some((t) => t.id === tab) ? tab : 'details';

  return (
    <div>
      <header className="mb-6 flex items-center gap-4">
        <Avatar name={person.fullName} className="size-16 text-xl" />
        <div className="min-w-0">
          <h1 className="font-display text-3xl font-semibold tracking-tight">{person.fullName}</h1>
          <p className="text-muted">{person.designation ?? 'Staff'}{person.departmentName && !person.designation?.includes(person.departmentName) ? ` · ${person.departmentName}` : ''}</p>
        </div>
        {full && full.status !== 'active' && <Badge tone="kumkum">{full.status === 'exited' ? 'Left the organisation' : 'Inactive'}</Badge>}
      </header>

      <Tabs tabs={tabs} value={active} onChange={setTab} />

      {active === 'details' && (
        <>
          <Panel className="divide-y divide-line">
            <Item label="Employee code" value={person.empCode} />
            <Item label="Work email" value={<a href={`mailto:${person.officialEmail}`} className="text-peacock hover:underline">{person.officialEmail}</a>} />
            {full && <>
              <Item label="Phone" value={full.phone ?? '—'} />
              <Item label="Reports to" value={full.reportingManagerName ?? '—'} />
              <Item label="Employment" value={EMPLOYMENT_TYPE[full.employmentType]} />
              <Item label="Joined" value={full.dateOfJoining ? fmtDate(full.dateOfJoining) : '—'} />
              {(own || isHr) && <Item label="Date of birth" value={full.dateOfBirth ? fmtDate(full.dateOfBirth) : '—'} />}
              {full.roles.length > 0 && <Item label="Roles" value={full.roles.map((r) => ROLE_LABEL[r] ?? r).join(', ')} />}
              {full.isManager && <Item label="Direct reports" value={String(full.directReports)} />}
              <Item label="Attendance" value={full.attendanceMethod === 'biometric' ? 'Biometric machine at head office' : 'Selfie and location in the portal'} />
              {(own || isHr) && <Item label="Location consent" value={full.locationConsentAt ? `Given on ${fmtDate(full.locationConsentAt.slice(0, 10))}` : 'Not given yet'} />}
              {(own || isHr) && <Item label="Photo consent" value={full.photoConsentAt ? `Given on ${fmtDate(full.photoConsentAt.slice(0, 10))}` : 'Not given yet'} />}
            </>}
          </Panel>
          {restricted && <div className="mt-4"><Notice tone="indigo">You can see the basics for people outside your team. Their attendance, leave and records are visible to their managers and HR.</Notice></div>}
          {detail.error && !restricted && <div className="mt-4"><ErrorNote error={detail.error} retry={detail.reload} /></div>}
          {isHr && !own && <p className="mt-4 text-sm text-muted">To change these details, use <a href="/admin/employees" className="font-medium text-peacock hover:underline">Employees</a> under HR and admin.</p>}
        </>
      )}

      {active === 'attendance' && full && <MonthCalendar employeeId={own ? undefined : id} month={month} onMonth={setMonth} />}
      {active === 'leave' && full && <PersonLeave id={id} />}
      {active === 'documents' && (own || isHr) && <DocumentsPanel employeeId={id} ownerName={person.fullName} />}
    </div>
  );
}

function PersonLeave({ id }: { id: string }) {
  const { data, error, loading, reload } = useApi<LeaveBalance[]>(`/employees/${id}/leave-balances`);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNote error={error} retry={reload} />;
  return <BalanceList balances={data ?? []} />;
}

function Item({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[11rem_1fr]">
      <dt className="text-muted">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
