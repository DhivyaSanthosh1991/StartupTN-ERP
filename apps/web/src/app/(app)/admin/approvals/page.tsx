'use client';

import { useState } from 'react';
import { Badge, Button, ErrorNote, Field, Input, Loading, Notice, PageHeader, Panel, Section, Select, useToast } from '@/components/ui';
import { api, errorText, useApi } from '@/lib/api';
import { REQUEST_TYPE_LABEL, ROLE_LABEL } from '@/lib/labels';
import type { DirectoryPerson } from '@/lib/types';

type Kind = 'reporting_manager' | 'department_head' | 'role' | 'employee';
interface Step { approverKind: Kind; approverRole: string | null; approverEmployeeId: string | null; minDays: number | null; slaHours: number }
interface Workflow { requestType: string; name: string; active: boolean; steps: (Step & { approverEmployeeName?: string | null })[] }

const KIND_LABEL: Record<Kind, string> = {
  reporting_manager: 'Their reporting manager',
  department_head: 'Head of their department',
  role: 'Anyone with a role',
  employee: 'One named person',
};

const ORDER = ['leave', 'od', 'permission', 'regularisation', 'od_home'];

export default function AdminApprovalsPage() {
  const flows = useApi<Workflow[]>('/admin/workflows');
  const people = useApi<DirectoryPerson[]>('/employees/directory');

  return (
    <div>
      <PageHeader title="Approval flows" description="Who must approve each kind of request, in order. The person asking is never asked to approve their own request." />
      {flows.loading && !flows.data && <Loading />}
      {flows.error && <ErrorNote error={flows.error} retry={flows.reload} />}
      {flows.data && [...flows.data].sort((a, b) => ORDER.indexOf(a.requestType) - ORDER.indexOf(b.requestType)).map((w) => (
        <FlowEditor key={w.requestType} flow={w} people={people.data ?? []} onSaved={flows.reload} />
      ))}
      <Notice tone="indigo">Changes apply to requests sent from now on. Requests already waiting keep the approvers they started with. If a step has no one to approve (for example the person has no manager), it is skipped, and if no steps remain HR approves.</Notice>
    </div>
  );
}

function FlowEditor({ flow, people, onSaved }: { flow: Workflow; people: DirectoryPerson[]; onSaved: () => void }) {
  const toast = useToast();
  const [steps, setSteps] = useState<Step[]>(flow.steps.map(({ approverKind, approverRole, approverEmployeeId, minDays, slaHours }) => ({ approverKind, approverRole, approverEmployeeId, minDays, slaHours })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const changed = JSON.stringify(steps) !== JSON.stringify(flow.steps.map(({ approverKind, approverRole, approverEmployeeId, minDays, slaHours }) => ({ approverKind, approverRole, approverEmployeeId, minDays, slaHours })));

  const update = (i: number, patch: Partial<Step>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (i: number, d: -1 | 1) => setSteps((s) => { const a = [...s]; [a[i], a[i + d]] = [a[i + d], a[i]]; return a; });

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api(`/admin/workflows/${flow.requestType}`, {
        method: 'PUT',
        body: { steps: steps.map((s) => ({ ...s, approverRole: s.approverKind === 'role' ? s.approverRole : null, approverEmployeeId: s.approverKind === 'employee' ? s.approverEmployeeId : null })) },
      });
      toast(`${REQUEST_TYPE_LABEL[flow.requestType] ?? flow.name} flow saved`);
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title={REQUEST_TYPE_LABEL[flow.requestType] ?? flow.name}>
      <Panel className="divide-y divide-line">
        {steps.map((s, i) => (
          <div key={i} className="grid gap-3 p-4 sm:grid-cols-[2rem_1fr_1fr_auto] sm:items-end">
            <Badge tone="neutral" className="w-fit sm:mb-2">{i + 1}</Badge>
            <div className="grid gap-3 sm:contents">
              <Field label="Approver">
                <Select value={s.approverKind} onChange={(e) => update(i, { approverKind: e.target.value as Kind })}>
                  {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </Field>
              {s.approverKind === 'role' ? (
                <Field label="Role">
                  <Select value={s.approverRole ?? ''} onChange={(e) => update(i, { approverRole: e.target.value })} required>
                    <option value="" disabled>Choose…</option>{Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </Select>
                </Field>
              ) : s.approverKind === 'employee' ? (
                <Field label="Person">
                  <Select value={s.approverEmployeeId ?? ''} onChange={(e) => update(i, { approverEmployeeId: e.target.value })} required>
                    <option value="" disabled>Choose…</option>{people.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
                  </Select>
                </Field>
              ) : <div />}
              <div className="flex items-end gap-2">
                <Field label="Reply within (hours)"><Input type="number" min={1} max={720} value={s.slaHours} onChange={(e) => update(i, { slaHours: Number(e.target.value) })} className="w-28" /></Field>
                {flow.requestType === 'leave' && (
                  <Field label="Only if longer than (days)"><Input type="number" min={0.5} step={0.5} value={s.minDays ?? ''} placeholder="Always" onChange={(e) => update(i, { minDays: e.target.value === '' ? null : Number(e.target.value) })} className="w-32" /></Field>
                )}
              </div>
            </div>
            <div className="flex gap-1 sm:col-start-4 sm:row-start-1">
              <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</Button>
              <Button size="sm" variant="ghost" disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</Button>
              <Button size="sm" variant="ghost" disabled={steps.length === 1} onClick={() => setSteps((x) => x.filter((_, j) => j !== i))} aria-label="Remove step">✕</Button>
            </div>
          </div>
        ))}
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <Button size="sm" variant="secondary" disabled={steps.length >= 5} onClick={() => setSteps((s) => [...s, { approverKind: 'role', approverRole: 'hr_admin', approverEmployeeId: null, minDays: null, slaHours: 48 }])}>Add a step</Button>
          <div className="flex items-center gap-3">
            {error && <span className="text-sm text-kumkum">{error}</span>}
            <Button size="sm" busy={busy} disabled={!changed} onClick={() => void save()}>Save flow</Button>
          </div>
        </div>
      </Panel>
    </Section>
  );
}
