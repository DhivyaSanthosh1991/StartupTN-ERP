'use client';

import { useState } from 'react';
import { Badge, Button, Check, Dialog, Empty, ErrorNote, Field, FormActions, Input, Loading, Notice, PageHeader, Panel, Section, Select, useToast } from '@/components/ui';
import { BiometricSetup } from '@/components/biometric-setup';
import { api, errorText, useApi } from '@/lib/api';
import { addDays, monthOf, todayIst } from '@/lib/dates';

interface Fence { id: string; name: string; kind: 'office' | 'field'; latitude: number; longitude: number; radiusM: number; active: boolean }

export default function AdminAttendancePage() {
  const toast = useToast();
  const fences = useApi<Fence[]>('/admin/geofences');
  const [editing, setEditing] = useState<Fence | 'new' | null>(null);
  const [month, setMonth] = useState(monthOf(todayIst()));
  const [range, setRange] = useState({ from: addDays(todayIst(), -7), to: todayIst() });
  const [busy, setBusy] = useState(false);

  async function refresh(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ employees: number; failed: number }>('/admin/attendance/refresh', { method: 'POST', body: range });
      if (r.failed) toast(`Rebuilt, but ${r.failed} of ${r.employees} could not be updated. Try again.`, 'error');
      else toast(`Attendance rebuilt for ${r.employees} ${r.employees === 1 ? 'person' : 'people'}`);
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader title="Attendance setup" description="Where people may check in from, the head-office biometric machine, and tools for the attendance register." />

      <Section title="Office and field locations" action={<Button size="sm" onClick={() => setEditing('new')}>Add location</Button>}>
        <p className="mb-4 max-w-prose text-sm text-muted">A check-in inside one of these circles counts as at the office. Outside every circle is still recorded, but flagged for the manager and HR to see.</p>
        {fences.loading && !fences.data && <Loading />}
        {fences.error && <ErrorNote error={fences.error} retry={fences.reload} />}
        {fences.data?.length === 0 && <Empty title="No locations yet">Until you add one, every check-in is marked “no office area is set up”.</Empty>}
        {fences.data && fences.data.length > 0 && (
          <Panel><ul className="divide-y divide-line">
            {fences.data.map((f) => (
              <li key={f.id} className={`flex flex-wrap items-center justify-between gap-3 px-4 py-3 ${f.active ? '' : 'opacity-60'}`}>
                <div>
                  <p className="font-medium">{f.name} {f.kind === 'field' && <Badge>Field</Badge>} {!f.active && <Badge tone="kumkum">Switched off</Badge>}</p>
                  <p className="text-sm text-muted">{f.latitude.toFixed(5)}, {f.longitude.toFixed(5)} · {f.radiusM} m radius ·{' '}
                    <a className="text-peacock hover:underline" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${f.latitude}&mlon=${f.longitude}#map=17/${f.latitude}/${f.longitude}`}>See on map</a></p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => setEditing(f)}>Edit</Button>
              </li>
            ))}
          </ul></Panel>
        )}
      </Section>

      <BiometricSetup />

      <Section title="Monthly register">
        <p className="mb-3 max-w-prose text-sm text-muted">Download every employee's day-by-day attendance for a month as a spreadsheet file (CSV), for payroll and records.</p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Month"><Input type="month" value={month} max={monthOf(todayIst())} onChange={(e) => e.target.value && setMonth(e.target.value)} className="w-44" /></Field>
          <a href={`/api/admin/attendance/export?month=${month}`} className="inline-flex h-10 items-center rounded-lg bg-peacock px-4 text-sm font-medium text-white hover:bg-peacock-dark" download>Download CSV</a>
        </div>
      </Section>

      <Section title="Rebuild the register">
        <p className="mb-3 max-w-prose text-sm text-muted">Attendance on screen is always worked out fresh. The stored register used for exports is refreshed every night. Rebuild it by hand if you have just corrected holidays or working hours for past days. Up to 93 days at a time.</p>
        <form onSubmit={refresh} className="flex flex-wrap items-end gap-3">
          <Field label="From"><Input type="date" required value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
          <Field label="To"><Input type="date" required value={range.to} min={range.from} max={todayIst()} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
          <Button type="submit" variant="secondary" busy={busy}>Rebuild</Button>
        </form>
      </Section>

      <FenceDialog target={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); void fences.reload(); }} />
    </div>
  );
}

function FenceDialog({ target, onClose, onDone }: { target: Fence | 'new' | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const blank = { name: '', kind: 'office', latitude: '', longitude: '', radiusM: '150', active: true };
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [seen, setSeen] = useState<string | null>(null);
  const key = target === 'new' ? 'new' : target?.id ?? null;

  if (key && key !== seen) {
    setSeen(key);
    setError('');
    setForm(target === 'new' || !target ? blank : { name: target.name, kind: target.kind, latitude: String(target.latitude), longitude: String(target.longitude), radiusM: String(target.radiusM), active: target.active });
  }
  if (!key && seen) setSeen(null);

  function useHere() {
    setError('');
    navigator.geolocation.getCurrentPosition(
      (p) => setForm((f) => ({ ...f, latitude: p.coords.latitude.toFixed(6), longitude: p.coords.longitude.toFixed(6) })),
      () => setError('Could not read your location. Allow location for this site, or type the coordinates.'),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const body = { name: form.name, kind: form.kind, latitude: Number(form.latitude), longitude: Number(form.longitude), radiusM: Number(form.radiusM), active: form.active };
    try {
      if (target === 'new') await api('/admin/geofences', { method: 'POST', body });
      else await api(`/admin/geofences/${(target as Fence).id}`, { method: 'PATCH', body });
      toast('Location saved');
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!target} onClose={onClose} title={target === 'new' ? 'Add a location' : 'Edit location'}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name"><Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Guindy office" /></Field>
        <Field label="Kind"><Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}><option value="office">Office</option><option value="field">Field or partner site</option></Select></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Latitude"><Input required inputMode="decimal" value={form.latitude} onChange={(e) => setForm({ ...form, latitude: e.target.value })} /></Field>
          <Field label="Longitude"><Input required inputMode="decimal" value={form.longitude} onChange={(e) => setForm({ ...form, longitude: e.target.value })} /></Field>
        </div>
        <Button variant="secondary" size="sm" onClick={useHere}>Use my current location</Button>
        <Field label="Radius (metres)" hint="Phones are rarely exact indoors. 100 to 200 m suits a single building."><Input type="number" required min={10} max={50000} value={form.radiusM} onChange={(e) => setForm({ ...form, radiusM: e.target.value })} /></Field>
        <Check label="In use" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
        {error && <Notice tone="kumkum">{error}</Notice>}
        <FormActions>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" busy={busy}>Save</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}
