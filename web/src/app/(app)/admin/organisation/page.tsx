'use client';

import { useState } from 'react';
import { Badge, Button, Check, Dialog, Empty, ErrorNote, Field, FormActions, Input, Loading, Notice, PageHeader, Panel, Section, Select, Textarea, useToast } from '@/components/ui';
import { api, errorText, useApi } from '@/lib/api';
import { fmtDate, fmtDay, todayIst } from '@/lib/dates';
import type { Department, DirectoryPerson } from '@/lib/types';

interface Holiday { id: string; date: string; name: string; optional: boolean }
interface Notice { id: string; title: string; body: string; published_at: string; expires_on: string | null; author: string | null }

export default function AdminOrganisationPage() {
  return (
    <div>
      <PageHeader title="Departments, holidays and notices" description="The structure and calendar everyone else sees." />
      <Departments />
      <Holidays />
      <Notices />
    </div>
  );
}

function Departments() {
  const toast = useToast();
  const list = useApi<Department[]>('/departments');
  const people = useApi<DirectoryPerson[]>('/employees/directory');
  const [editing, setEditing] = useState<Department | 'new' | null>(null);
  const [form, setForm] = useState({ name: '', headEmployeeId: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [seen, setSeen] = useState<string | null>(null);
  const key = editing === 'new' ? 'new' : editing?.id ?? null;

  if (key && key !== seen) {
    setSeen(key);
    setError('');
    setForm(editing === 'new' || !editing ? { name: '', headEmployeeId: '' } : { name: editing.name, headEmployeeId: editing.headEmployeeId ?? '' });
  }
  if (!key && seen) setSeen(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const body = { name: form.name, headEmployeeId: form.headEmployeeId || null };
    try {
      if (editing === 'new') await api('/admin/departments', { method: 'POST', body });
      else await api(`/admin/departments/${(editing as Department).id}`, { method: 'PATCH', body });
      toast('Department saved');
      setEditing(null);
      await list.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Departments" action={<Button size="sm" onClick={() => setEditing('new')}>Add department</Button>}>
      {list.loading && !list.data && <Loading />}
      {list.error && <ErrorNote error={list.error} retry={list.reload} />}
      {list.data && (
        <Panel><ul className="divide-y divide-line">
          {list.data.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div><p className="font-medium">{d.name}</p><p className="text-sm text-muted">{d.headName ? `Head: ${d.headName}` : 'No head set'} · {d.headcount} {d.headcount === 1 ? 'person' : 'people'}</p></div>
              <Button size="sm" variant="secondary" onClick={() => setEditing(d)}>Edit</Button>
            </li>
          ))}
        </ul></Panel>
      )}
      <p className="mt-2 text-sm text-muted">A head of department also needs the “Head of department” role, set under Employees, to see their whole department.</p>
      <Dialog open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add a department' : 'Edit department'}>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Name"><Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Head"><Select value={form.headEmployeeId} onChange={(e) => setForm({ ...form, headEmployeeId: e.target.value })}><option value="">No one yet</option>{people.data?.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}</Select></Field>
          {error && <Notice tone="kumkum">{error}</Notice>}
          <FormActions><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button type="submit" busy={busy}>Save</Button></FormActions>
        </form>
      </Dialog>
    </Section>
  );
}

function Holidays() {
  const toast = useToast();
  const [year, setYear] = useState(Number(todayIst().slice(0, 4)));
  const list = useApi<Holiday[]>(`/holidays?year=${year}`);
  const [form, setForm] = useState({ date: '', name: '', optional: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/admin/holidays', { method: 'POST', body: form });
      toast('Holiday added');
      setForm({ date: '', name: '', optional: false });
      await list.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(h: Holiday) {
    try {
      await api(`/admin/holidays/${h.id}`, { method: 'DELETE' });
      toast(`${h.name} removed`);
      await list.reload();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  return (
    <Section title="Holidays" action={
      <Select value={year} onChange={(e) => setYear(Number(e.target.value))} className="w-28" aria-label="Year">
        {[year - 1, year, year + 1].filter((v, i, a) => a.indexOf(v) === i).map((y) => <option key={y} value={y}>{y}</option>)}
      </Select>}>
      <form onSubmit={add} className="mb-4 grid gap-3 rounded-xl border border-line bg-surface p-4 sm:grid-cols-[10rem_1fr_auto_auto] sm:items-end">
        <Field label="Date"><Input type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
        <Field label="Holiday"><Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Pongal" /></Field>
        <div className="sm:mb-2"><Check label="Optional" checked={form.optional} onChange={(e) => setForm({ ...form, optional: e.target.checked })} /></div>
        <Button type="submit" busy={busy}>Add</Button>
        {error && <div className="sm:col-span-4"><Notice tone="kumkum">{error}</Notice></div>}
      </form>
      {list.loading && !list.data && <Loading />}
      {list.error && <ErrorNote error={list.error} retry={list.reload} />}
      {list.data?.length === 0 && <Empty title={`No holidays for ${year}`}>Add the year's list. Leave and attendance skip these days.</Empty>}
      {list.data && list.data.length > 0 && (
        <Panel><ul className="divide-y divide-line">
          {list.data.map((h) => (
            <li key={h.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
              <span><span className="font-medium">{fmtDay(h.date)}</span> {h.name} {h.optional && <Badge>Optional</Badge>}</span>
              <Button size="sm" variant="ghost" onClick={() => void remove(h)}>Remove</Button>
            </li>
          ))}
        </ul></Panel>
      )}
    </Section>
  );
}

function Notices() {
  const toast = useToast();
  const list = useApi<Notice[]>('/notices');
  const [form, setForm] = useState({ title: '', body: '', expiresOn: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/admin/notices', { method: 'POST', body: { title: form.title, body: form.body, expiresOn: form.expiresOn || null } });
      toast('Notice published');
      setForm({ title: '', body: '', expiresOn: '' });
      await list.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(n: Notice) {
    try {
      await api(`/admin/notices/${n.id}`, { method: 'DELETE' });
      toast('Notice removed');
      await list.reload();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  return (
    <Section title="Notices">
      <form onSubmit={add} className="mb-4 space-y-3 rounded-xl border border-line bg-surface p-4">
        <Field label="Title"><Input required maxLength={160} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
        <Field label="Message"><Textarea required rows={4} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></Field>
        <Field label="Show until" hint="Leave blank to keep it up until you remove it." className="max-w-48"><Input type="date" min={todayIst()} value={form.expiresOn} onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} /></Field>
        {error && <Notice tone="kumkum">{error}</Notice>}
        <Button type="submit" busy={busy}>Publish to everyone</Button>
      </form>
      {list.data?.length === 0 && <Empty title="No notices are showing" />}
      {list.data && list.data.length > 0 && (
        <Panel><ul className="divide-y divide-line">
          {list.data.map((n) => (
            <li key={n.id} className="flex items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0"><p className="font-medium">{n.title}</p><p className="line-clamp-2 text-sm text-muted">{n.body}</p><p className="mt-1 text-xs text-muted">{n.expires_on ? `Until ${fmtDate(n.expires_on)}` : 'No end date'}</p></div>
              <Button size="sm" variant="ghost" onClick={() => void remove(n)}>Remove</Button>
            </li>
          ))}
        </ul></Panel>
      )}
    </Section>
  );
}
