'use client';

import { useEffect, useState } from 'react';
import { Avatar, Badge, Button, Check, Dialog, Empty, ErrorNote, Field, FormActions, Input, Loading, Notice, PageHeader, Select, TableWrap, td, th, useToast } from '@/components/ui';
import { api, errorText, useApi } from '@/lib/api';
import { fmtDate } from '@/lib/dates';
import { ATTENDANCE_METHOD, EMPLOYMENT_TYPE, ROLE_LABEL } from '@/lib/labels';
import { Role, useSession } from '@/lib/session';
import type { Department, EmployeeProfile } from '@/lib/types';

const ROLES: Role[] = ['hod', 'md', 'hr_admin', 'finance', 'super_admin'];

interface FormState {
  empCode: string; fullName: string; officialEmail: string; phone: string; designation: string; departmentId: string;
  employmentType: string; dateOfJoining: string; dateOfBirth: string; gender: string; workLocationId: string; reportingManagerId: string; status: string; exitDate: string; roles: Role[];
  attendanceMethod: string; biometricCode: string;
}
const EMPTY: FormState = {
  empCode: '', fullName: '', officialEmail: '', phone: '', designation: '', departmentId: '', employmentType: 'permanent', gender: '', workLocationId: '',
  dateOfJoining: '', dateOfBirth: '', reportingManagerId: '', status: 'active', exitDate: '', roles: [],
  attendanceMethod: 'selfie', biometricCode: '',
};

export default function AdminEmployeesPage() {
  const { isHr, has } = useSession();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('active');
  useEffect(() => { const t = setTimeout(() => setQuery(search.trim()), 250); return () => clearTimeout(t); }, [search]);
  const params = new URLSearchParams();
  if (query) params.set('search', query);
  if (status) params.set('status', status);
  const list = useApi<EmployeeProfile[]>(`/employees?${params}`);
  const everyone = useApi<EmployeeProfile[]>('/employees');
  const departments = useApi<Department[]>('/departments');
  const [editing, setEditing] = useState<EmployeeProfile | 'new' | null>(null);

  return (
    <div>
      <PageHeader title="Employees" description={isHr ? 'Add people, change their details and set who they report to.' : 'Assign roles to people.'}
        actions={isHr ? <Button onClick={() => setEditing('new')}>Add employee</Button> : undefined} />
      <div className="mb-4 flex flex-wrap gap-3">
        <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, code or email" className="max-w-xs" aria-label="Search" />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40" aria-label="Status">
          <option value="active">Active</option><option value="inactive">Inactive</option><option value="exited">Left</option><option value="">Everyone</option>
        </Select>
      </div>

      {list.loading && !list.data && <Loading />}
      {list.error && <ErrorNote error={list.error} retry={list.reload} />}
      {list.data?.length === 0 && <Empty title="No one matches" />}
      {list.data && list.data.length > 0 && (
        <TableWrap>
          <thead><tr><th className={th}>Name</th><th className={th}>Department</th><th className={th}>Reports to</th><th className={th}>Joined</th><th className={th}>Roles</th></tr></thead>
          <tbody>
            {list.data.map((p) => (
              <tr key={p.id} className="cursor-pointer hover:bg-wash/50" onClick={() => setEditing(p)}>
                <td className={td}>
                  <span className="flex items-center gap-3">
                    <Avatar name={p.fullName} className="size-8 text-xs" />
                    <span>
                      <button type="button" className="text-left font-medium hover:underline" onClick={() => setEditing(p)}>{p.fullName}</button>
                      <span className="block text-xs text-muted">{p.empCode} · {p.designation ?? 'No title'}{p.attendanceMethod === 'biometric' ? ' · biometric' : ''}{p.status !== 'active' ? ` · ${p.status === 'exited' ? 'left' : 'inactive'}` : ''}</span>
                    </span>
                  </span>
                </td>
                <td className={td}>{p.departmentName ?? '—'}</td>
                <td className={td}>{p.reportingManagerName ?? '—'}</td>
                <td className={td}>{p.dateOfJoining ? fmtDate(p.dateOfJoining) : '—'}</td>
                <td className={td}><span className="flex flex-wrap gap-1">{p.roles.length ? p.roles.map((r) => <Badge key={r} tone="indigo">{ROLE_LABEL[r] ?? r}</Badge>) : <span className="text-muted">—</span>}</span></td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      <EmployeeDialog target={editing} people={everyone.data ?? []} departments={departments.data ?? []} canEdit={isHr} canRoles={has('super_admin')}
        onClose={() => setEditing(null)} onDone={() => { setEditing(null); void list.reload(); void everyone.reload(); }} />
    </div>
  );
}

function EmployeeDialog({ target, people, departments, canEdit, canRoles, onClose, onDone }: {
  target: EmployeeProfile | 'new' | null; people: EmployeeProfile[]; departments: Department[]; canEdit: boolean; canRoles: boolean; onClose: () => void; onDone: () => void;
}) {
  const locations = useApi<{ id: string; name: string }[]>('/attendance/geofences');
  const toast = useToast();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [seen, setSeen] = useState<string | null>(null);
  const key = target === 'new' ? 'new' : target?.id ?? null;

  if (key && key !== seen) {
    setSeen(key);
    setError('');
    setForm(target === 'new' || !target ? EMPTY : {
      empCode: target.empCode, fullName: target.fullName, officialEmail: target.officialEmail, phone: target.phone ?? '', designation: target.designation ?? '',
      departmentId: target.departmentId ?? '', employmentType: target.employmentType, dateOfJoining: target.dateOfJoining ?? '', dateOfBirth: target.dateOfBirth ?? '', gender: target.gender ?? '', workLocationId: target.workLocationId ?? '',
      reportingManagerId: target.reportingManagerId ?? '', status: target.status, exitDate: target.exitDate ?? '', roles: target.roles as Role[],
      attendanceMethod: target.attendanceMethod, biometricCode: target.biometricCode ?? '',
    });
  }
  if (!key && seen) setSeen(null);

  const isNew = target === 'new';
  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (canEdit) {
        const body: Record<string, unknown> = {
          empCode: form.empCode, fullName: form.fullName, officialEmail: form.officialEmail, phone: form.phone || null, designation: form.designation || null,
          departmentId: form.departmentId || null, employmentType: form.employmentType, dateOfJoining: form.dateOfJoining || null,
          dateOfBirth: form.dateOfBirth || null, gender: form.gender || null, workLocationId: form.workLocationId || null, reportingManagerId: form.reportingManagerId || null,
          attendanceMethod: form.attendanceMethod, biometricCode: form.attendanceMethod === 'biometric' ? form.biometricCode.trim() : null,
        };
        if (!isNew) { body.status = form.status; body.exitDate = form.exitDate || null; }
        const saved = isNew
          ? await api<EmployeeProfile>('/employees', { method: 'POST', body })
          : await api<EmployeeProfile>(`/employees/${(target as EmployeeProfile).id}`, { method: 'PATCH', body });
        if (canRoles && JSON.stringify([...form.roles].sort()) !== JSON.stringify([...(saved.roles ?? [])].sort())) {
          await api(`/employees/${saved.id}/roles`, { method: 'PUT', body: { roles: form.roles } });
        }
      } else if (canRoles && target && target !== 'new') {
        await api(`/employees/${target.id}/roles`, { method: 'PUT', body: { roles: form.roles } });
      }
      toast(isNew ? `${form.fullName} added` : 'Changes saved');
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const managers = people.filter((p) => p.status === 'active' && (isNew || p.id !== (target as EmployeeProfile)?.id));

  return (
    <Dialog open={!!target} onClose={onClose} wide title={isNew ? 'Add an employee' : (target as EmployeeProfile | null)?.fullName ?? ''}>
      <form onSubmit={submit} className="space-y-4">
        {canEdit && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Employee code"><Input required value={form.empCode} onChange={(e) => set({ empCode: e.target.value })} /></Field>
              <Field label="Full name"><Input required value={form.fullName} onChange={(e) => set({ fullName: e.target.value })} /></Field>
              <Field label="Work email" hint="Must be their Google Workspace address, or they cannot sign in."><Input type="email" required value={form.officialEmail} onChange={(e) => set({ officialEmail: e.target.value })} /></Field>
              <Field label="Phone"><Input value={form.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
              <Field label="Designation"><Input value={form.designation} onChange={(e) => set({ designation: e.target.value })} /></Field>
              <Field label="Department">
                <Select value={form.departmentId} onChange={(e) => set({ departmentId: e.target.value })}>
                  <option value="">None</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </Select>
              </Field>
              <Field label="Employment type">
                <Select value={form.employmentType} onChange={(e) => set({ employmentType: e.target.value })}>
                  {Object.entries(EMPLOYMENT_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </Field>
              <Field label="Reports to">
                <Select value={form.reportingManagerId} onChange={(e) => set({ reportingManagerId: e.target.value })}>
                  <option value="">No one</option>{managers.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
                </Select>
              </Field>
              <Field label="Date of joining"><Input type="date" value={form.dateOfJoining} onChange={(e) => set({ dateOfJoining: e.target.value })} /></Field>
              <Field label="Date of birth"><Input type="date" value={form.dateOfBirth} onChange={(e) => set({ dateOfBirth: e.target.value })} /></Field>
              <Field label="Work location" hint="Check-ins are judged against this place. Leave empty to accept any location.">
                <Select value={form.workLocationId} onChange={(e) => set({ workLocationId: e.target.value })}>
                  <option value="">Not set</option>{(locations.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </Select>
              </Field>
              <Field label="Gender" hint="Decides who sees maternity and paternity leave.">
                <Select value={form.gender} onChange={(e) => set({ gender: e.target.value })}>
                  <option value="">Not set</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option>
                </Select>
              </Field>
            </div>
            <div className="grid gap-3 rounded-lg border border-line bg-wash/50 p-3 sm:grid-cols-2">
              <Field label="How attendance is taken" hint="Head office staff use the biometric machine; everyone else checks in with a selfie. On an approved on-duty day everyone uses the selfie.">
                <Select value={form.attendanceMethod} onChange={(e) => set({ attendanceMethod: e.target.value })}>
                  {Object.entries(ATTENDANCE_METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </Field>
              {form.attendanceMethod === 'biometric' && (
                <Field label="Code on the machine" hint="The number the machine knows this person by. Often the same as the employee code.">
                  <Input required value={form.biometricCode} onChange={(e) => set({ biometricCode: e.target.value })} />
                </Field>
              )}
            </div>
            {!isNew && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Status">
                  <Select value={form.status} onChange={(e) => set({ status: e.target.value })}>
                    <option value="active">Active</option><option value="inactive">Inactive</option><option value="exited">Left the organisation</option>
                  </Select>
                </Field>
                {form.status === 'exited' && <Field label="Last working day"><Input type="date" value={form.exitDate} onChange={(e) => set({ exitDate: e.target.value })} /></Field>}
              </div>
            )}
          </>
        )}
        {!canEdit && <p className="text-sm text-muted">{(target as EmployeeProfile | null)?.designation} · {(target as EmployeeProfile | null)?.officialEmail}</p>}
        {canRoles && !isNew && (
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Roles</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {ROLES.map((r) => (
                <Check key={r} label={ROLE_LABEL[r]} checked={form.roles.includes(r)}
                  onChange={(e) => set({ roles: e.target.checked ? [...form.roles, r] : form.roles.filter((x) => x !== r) })} />
              ))}
            </div>
            <p className="mt-2 text-xs text-muted">Everyone is an employee. A manager is anyone with people reporting to them; they need no role. Roles add access: HR sees everyone, a head of department sees their department.</p>
          </fieldset>
        )}
        {error && <Notice tone="kumkum">{error}</Notice>}
        <FormActions>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" busy={busy}>{isNew ? 'Add employee' : 'Save changes'}</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}
