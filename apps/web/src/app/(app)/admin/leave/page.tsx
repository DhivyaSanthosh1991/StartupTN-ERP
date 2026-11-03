'use client';

import { useState } from 'react';
import { Badge, Button, Check, Dialog, ErrorNote, Field, FormActions, Input, Loading, Notice, PageHeader, Section, Select, TableWrap, Textarea, td, th, useToast } from '@/components/ui';
import { api, errorText, useApi } from '@/lib/api';
import { EMPLOYMENT_TYPE } from '@/lib/labels';
import { todayIst } from '@/lib/dates';
import type { DirectoryPerson } from '@/lib/types';

interface LeaveType {
  id: string; code: string; name: string; annualEntitlement: number; accrual: 'upfront' | 'monthly' | 'event'; carryForwardMax: number; allowHalfDay: boolean;
  paid: boolean; applicableEmploymentTypes: string[]; requiresDocumentAfterDays: number | null; active: boolean; sortOrder: number;
}

const BLANK = {
  code: '', name: '', annualEntitlement: '12', accrual: 'upfront', carryForwardMax: '0', allowHalfDay: true, paid: true,
  applicableEmploymentTypes: ['permanent'] as string[], requiresDocumentAfterDays: '', active: true, sortOrder: '10',
};

export default function AdminLeavePage() {
  const types = useApi<LeaveType[]>('/admin/leave-types');
  const [editing, setEditing] = useState<LeaveType | 'new' | null>(null);

  return (
    <div>
      <PageHeader title="Leave rules" description="What kinds of leave exist, how much each person gets, and who it applies to."
        actions={<Button onClick={() => setEditing('new')}>Add leave type</Button>} />
      {types.loading && !types.data && <Loading />}
      {types.error && <ErrorNote error={types.error} retry={types.reload} />}
      {types.data && (
        <TableWrap>
          <thead><tr><th className={th}>Leave</th><th className={th}>Per year</th><th className={th}>Given</th><th className={th}>Carry forward</th><th className={th}>Applies to</th><th className={th}></th></tr></thead>
          <tbody>
            {types.data.map((t) => (
              <tr key={t.id} className={t.active ? '' : 'opacity-60'}>
                <td className={td}><span className="font-medium">{t.name}</span> <span className="text-xs text-muted">{t.code}</span>
                  <span className="mt-0.5 flex gap-1">{!t.paid && <Badge>Unpaid</Badge>}{!t.active && <Badge tone="kumkum">Switched off</Badge>}{t.allowHalfDay && <Badge>Half days</Badge>}</span></td>
                <td className={td}>{t.paid ? t.annualEntitlement : 'No limit'}</td>
                <td className={td}>{t.accrual === 'monthly' ? 'Month by month' : t.accrual === 'event' ? 'Per event' : 'All at the start'}</td>
                <td className={td}>{t.carryForwardMax > 0 ? `Up to ${t.carryForwardMax}` : 'None'}</td>
                <td className={td}>{t.applicableEmploymentTypes.map((e) => EMPLOYMENT_TYPE[e]).join(', ')}</td>
                <td className={td}><Button size="sm" variant="secondary" onClick={() => setEditing(t)}>Edit</Button></td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      <p className="mt-3 max-w-prose text-sm text-muted">Changing the days per year affects balances calculated from now on. To fix one person's balance, use an adjustment below, so there is a record of why.</p>

      <Adjust types={types.data ?? []} />
      <TypeDialog target={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); void types.reload(); }} />
    </div>
  );
}

function TypeDialog({ target, onClose, onDone }: { target: LeaveType | 'new' | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [seen, setSeen] = useState<string | null>(null);
  const key = target === 'new' ? 'new' : target?.id ?? null;

  if (key && key !== seen) {
    setSeen(key);
    setError('');
    setForm(target === 'new' || !target ? BLANK : {
      code: target.code, name: target.name, annualEntitlement: String(target.annualEntitlement), accrual: target.accrual, carryForwardMax: String(target.carryForwardMax),
      allowHalfDay: target.allowHalfDay, paid: target.paid, applicableEmploymentTypes: target.applicableEmploymentTypes,
      requiresDocumentAfterDays: target.requiresDocumentAfterDays === null ? '' : String(target.requiresDocumentAfterDays), active: target.active, sortOrder: String(target.sortOrder),
    });
  }
  if (!key && seen) setSeen(null);
  const isNew = target === 'new';
  const set = (p: Partial<typeof BLANK>) => setForm((f) => ({ ...f, ...p }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const body = {
      ...(isNew ? { code: form.code } : {}), name: form.name, annualEntitlement: Number(form.annualEntitlement), accrual: form.accrual, carryForwardMax: Number(form.carryForwardMax),
      allowHalfDay: form.allowHalfDay, paid: form.paid, applicableEmploymentTypes: form.applicableEmploymentTypes,
      requiresDocumentAfterDays: form.requiresDocumentAfterDays === '' ? null : Number(form.requiresDocumentAfterDays), active: form.active, sortOrder: Number(form.sortOrder),
    };
    try {
      if (isNew) await api('/admin/leave-types', { method: 'POST', body });
      else await api(`/admin/leave-types/${(target as LeaveType).id}`, { method: 'PATCH', body });
      toast('Leave type saved');
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!target} onClose={onClose} wide title={isNew ? 'Add a leave type' : 'Edit leave type'}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><Input required value={form.name} onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label="Short code" hint={isNew ? 'Letters and digits, up to 10. Cannot be changed later.' : undefined}><Input required disabled={!isNew} maxLength={10} value={form.code} onChange={(e) => set({ code: e.target.value.toUpperCase() })} /></Field>
          <Field label="Days per year"><Input type="number" min={0} max={365} step={0.5} value={form.annualEntitlement} onChange={(e) => set({ annualEntitlement: e.target.value })} disabled={!form.paid} /></Field>
          <Field label="How it is given">
            <Select value={form.accrual} onChange={(e) => set({ accrual: e.target.value })}>
              <option value="upfront">All at the start of the year</option><option value="monthly">A little each month</option><option value="event">Per event (maternity, paternity)</option>
            </Select>
          </Field>
          <Field label="Carry forward at most" hint="Days left over that move into next year."><Input type="number" min={0} max={365} step={0.5} value={form.carryForwardMax} onChange={(e) => set({ carryForwardMax: e.target.value })} /></Field>
          <Field label="Supporting document needed after" hint="Number of days. Leave blank if never."><Input type="number" min={0} max={365} value={form.requiresDocumentAfterDays} onChange={(e) => set({ requiresDocumentAfterDays: e.target.value })} /></Field>
          <Field label="Order in lists"><Input type="number" min={0} max={1000} value={form.sortOrder} onChange={(e) => set({ sortOrder: e.target.value })} /></Field>
        </div>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Applies to</legend>
          <div className="flex flex-wrap gap-4">
            {Object.entries(EMPLOYMENT_TYPE).map(([k, v]) => (
              <Check key={k} label={v} checked={form.applicableEmploymentTypes.includes(k)}
                onChange={(e) => set({ applicableEmploymentTypes: e.target.checked ? [...form.applicableEmploymentTypes, k] : form.applicableEmploymentTypes.filter((x) => x !== k) })} />
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap gap-5">
          <Check label="Paid leave" checked={form.paid} onChange={(e) => set({ paid: e.target.checked })} />
          <Check label="Half days allowed" checked={form.allowHalfDay} onChange={(e) => set({ allowHalfDay: e.target.checked })} />
          <Check label="In use" checked={form.active} onChange={(e) => set({ active: e.target.checked })} />
        </div>
        {error && <Notice tone="kumkum">{error}</Notice>}
        <FormActions>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" busy={busy}>Save</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function Adjust({ types }: { types: LeaveType[] }) {
  const toast = useToast();
  const people = useApi<DirectoryPerson[]>('/employees/directory');
  const [form, setForm] = useState({ employeeId: '', leaveTypeId: '', year: String(Number(todayIst().slice(0, 4))), days: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/admin/leave-adjustments', { method: 'POST', body: { ...form, year: Number(form.year), days: Number(form.days) } });
      toast('Balance adjusted');
      setForm({ ...form, days: '', note: '' });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Adjust someone's balance" className="mt-10">
      <p className="mb-4 max-w-prose text-sm text-muted">Add or remove days for one person. Use a plus number to give days (for example opening balances when you start using this portal) and a minus number to take them away. Every adjustment is recorded with your note.</p>
      <form onSubmit={submit} className="grid gap-3 rounded-xl border border-line bg-surface p-4 sm:grid-cols-2">
        <Field label="Employee">
          <Select required value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
            <option value="" disabled>Choose…</option>{people.data?.map((p) => <option key={p.id} value={p.id}>{p.fullName} ({p.empCode})</option>)}
          </Select>
        </Field>
        <Field label="Leave type">
          <Select required value={form.leaveTypeId} onChange={(e) => setForm({ ...form, leaveTypeId: e.target.value })}>
            <option value="" disabled>Choose…</option>{types.filter((t) => t.paid && t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
        <Field label="Leave year"><Input type="number" required min={2000} max={2100} value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} /></Field>
        <Field label="Days (+ or −)"><Input type="number" required step={0.5} value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} placeholder="e.g. 4 or -1.5" /></Field>
        <Field label="Why" className="sm:col-span-2"><Textarea required minLength={3} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
        {error && <div className="sm:col-span-2"><Notice tone="kumkum">{error}</Notice></div>}
        <div className="sm:col-span-2"><Button type="submit" busy={busy}>Record adjustment</Button></div>
      </form>
    </Section>
  );
}
