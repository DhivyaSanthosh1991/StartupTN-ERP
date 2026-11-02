'use client';

import { useState } from 'react';
import { Button, Check, ErrorNote, Field, Input, Loading, Notice, PageHeader, Panel, Select, useToast } from '@/components/ui';
import { api, errorText, useApi } from '@/lib/api';

interface Settings {
  work_start: string; grace_minutes: number; full_day_minutes: number; half_day_minutes: number; weekly_off_days: number[];
  leave_year_start_month: number; leave_backdate_days: number; regularisation_window_days: number;
  permission_max_minutes: number; permission_monthly_limit: number; geofence_low_accuracy_m: number;
  attendance_start_date: string | null;
  selfie_required: boolean; selfie_retention_days: number;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export default function AdminSettingsPage() {
  const { data, error, loading, reload } = useApi<Settings>('/admin/settings');
  return (
    <div>
      <PageHeader title="Working hours and rules" description="The numbers attendance, leave and permission are worked out from." />
      {loading && !data && <Loading />}
      {error && <ErrorNote error={error} retry={reload} />}
      {data && <SettingsForm initial={data} onSaved={reload} />}
    </div>
  );
}

function SettingsForm({ initial, onSaved }: { initial: Settings; onSaved: () => void }) {
  const toast = useToast();
  const [s, setS] = useState({ ...initial });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const num = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [k]: Number(e.target.value) });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/admin/settings', { method: 'PUT', body: s });
      toast('Settings saved');
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-6">
      <Panel className="grid gap-4 p-5 sm:grid-cols-2">
        <Field label="Work starts at"><Input type="time" required value={s.work_start} onChange={(e) => setS({ ...s, work_start: e.target.value })} /></Field>
        <Field label="Grace period (minutes)" hint="Arriving within this time after the start is not late."><Input type="number" min={0} max={120} value={s.grace_minutes} onChange={num('grace_minutes')} /></Field>
        <Field label="Minutes for a full day" hint={`${(s.full_day_minutes / 60).toFixed(1)} hours`}><Input type="number" min={60} max={960} value={s.full_day_minutes} onChange={num('full_day_minutes')} /></Field>
        <Field label="Minutes for a half day" hint={`${(s.half_day_minutes / 60).toFixed(1)} hours`}><Input type="number" min={30} max={600} value={s.half_day_minutes} onChange={num('half_day_minutes')} /></Field>
        <Field label="Attendance is tracked from" hint="The day this portal goes live. Days before it show nothing, instead of “absent”. Leave blank to count from each person's joining date." className="sm:col-span-2 sm:max-w-sm">
          <Input type="date" value={s.attendance_start_date ?? ''} onChange={(e) => setS({ ...s, attendance_start_date: e.target.value || null })} />
        </Field>
        <fieldset className="sm:col-span-2">
          <legend className="mb-2 text-sm font-medium">Weekly off</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {DAYS.map((d, i) => (
              <Check key={d} label={d} checked={s.weekly_off_days.includes(i)}
                onChange={(e) => setS({ ...s, weekly_off_days: e.target.checked ? [...s.weekly_off_days, i].sort() : s.weekly_off_days.filter((x) => x !== i) })} />
            ))}
          </div>
        </fieldset>
      </Panel>

      <Panel className="grid gap-4 p-5 sm:grid-cols-2">
        <Field label="Leave year starts in"><Select value={s.leave_year_start_month} onChange={(e) => setS({ ...s, leave_year_start_month: Number(e.target.value) })}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</Select></Field>
        <Field label="Apply for leave up to (days back)" hint="How far into the past a leave request may start."><Input type="number" min={0} max={90} value={s.leave_backdate_days} onChange={num('leave_backdate_days')} /></Field>
        <Field label="Attendance corrections allowed for (days back)"><Input type="number" min={1} max={90} value={s.regularisation_window_days} onChange={num('regularisation_window_days')} /></Field>
        <Field label="Longest permission (minutes)"><Input type="number" min={15} max={480} value={s.permission_max_minutes} onChange={num('permission_max_minutes')} /></Field>
        <Field label="Permissions per person per month"><Input type="number" min={0} max={31} value={s.permission_monthly_limit} onChange={num('permission_monthly_limit')} /></Field>
        <Field label="Weak GPS signal above (metres)" hint="A check-in less precise than this is flagged. Above 500 m is refused."><Input type="number" min={10} max={5000} value={s.geofence_low_accuracy_m} onChange={num('geofence_low_accuracy_m')} /></Field>
      </Panel>

      <Panel className="grid gap-4 p-5 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Check label="Check-in and check-out take a live selfie" checked={s.selfie_required} onChange={(e) => setS({ ...s, selfie_required: e.target.checked })} />
          <p className="mt-1 text-xs text-muted">
            The camera opens when someone presses the button, and the photo is saved with their location. Switch this off only while cameras are not available;
            check-ins are then recorded with location alone.
          </p>
        </div>
        <Field label="Keep selfies for (days)" hint="After this, the photo is deleted. The check-in time and location stay. Between 7 and 365.">
          <Input type="number" min={7} max={365} value={s.selfie_retention_days} onChange={num('selfie_retention_days')} />
        </Field>
      </Panel>

      <Notice tone="indigo">Changes apply from now. Days already worked out for the past are not changed unless you rebuild the register under Attendance setup.</Notice>
      {error && <Notice tone="kumkum">{error}</Notice>}
      <Button type="submit" busy={busy}>Save settings</Button>
    </form>
  );
}
