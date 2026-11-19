'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Bar, PctBadge, RoleChip } from '@/components/project-parts';
import { Badge, Button, Dialog, Empty, ErrorNote, Field, FormActions, Input, Loading, Notice, PageHeader, Panel, Section, Select, Tabs, useToast } from '@/components/ui';
import { api, errorText, useApi } from '@/lib/api';
import { fmtDate } from '@/lib/dates';
import { GROUPS, byGroup } from '@/lib/projects';
import type { CompletedProject, ProjectMapping, ProjectSummary } from '@/lib/projects';
import { useSession } from '@/lib/session';
import { useTab } from '@/lib/use-tab';

type TabId = 'projects' | 'reports' | 'resources';

export default function ProjectsPage() {
  const { has } = useSession();
  const admin = has('hr_admin', 'super_admin');
  const [tab, setTab] = useTab<TabId>(['projects', 'reports', 'resources'], 'projects');
  const list = useApi<ProjectSummary[]>('/projects');
  const [creating, setCreating] = useState(false);

  return (
    <div>
      <PageHeader title="Projects" description="Each project's KPI targets, milestones and the team on it, for the financial year."
        actions={admin && <Button onClick={() => setCreating(true)}>New project</Button>} />
      <Tabs value={tab} onChange={setTab} tabs={[
        { id: 'projects', label: admin ? 'All projects' : 'My projects' },
        { id: 'reports', label: 'Completed reports' },
        { id: 'resources', label: 'Resources' },
      ]} />
      {tab === 'projects' && <ProjectList list={list} admin={admin} onLoaded={list.reload} />}
      {tab === 'reports' && <CompletedReports />}
      {tab === 'resources' && <Resources admin={admin} onChanged={list.reload} />}
      {admin && <NewProject open={creating} onClose={() => setCreating(false)} onCreated={list.reload} />}
    </div>
  );
}

// ------------------------------------------------------------------ the project list

function ProjectList({ list, admin, onLoaded }: { list: ReturnType<typeof useApi<ProjectSummary[]>>; admin: boolean; onLoaded: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ created: number; mapped: number; unmatched: string[] } | null>(null);

  async function loadProgramme() {
    setBusy(true);
    try {
      setResult(await api('/projects/programme', { method: 'POST' }));
      onLoaded();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (list.loading && !list.data) return <Loading />;
  if (list.error) return <ErrorNote error={list.error} retry={list.reload} />;
  const projects = list.data ?? [];
  const waiting = projects.reduce((n, p) => n + p.pending, 0);

  return (
    <div>
      {result && (
        <div className="mb-5"><Notice tone="peacock">
          Loaded {result.created} projects and mapped {result.mapped} people.
          {result.unmatched.length > 0 && <> These names in the work programme did not match an employee, so map them in the Resources tab: {result.unmatched.join(', ')}.</>}
        </Notice></div>
      )}
      {admin && waiting > 0 && <div className="mb-5"><Notice>{waiting} {waiting === 1 ? 'item is' : 'items are'} waiting for your review. Open a project and use its Approvals tab.</Notice></div>}
      {projects.length === 0 && (
        <Empty title={admin ? 'No projects yet' : 'You are not on any project yet'}>
          {admin
            ? <><p>Load the FY 2026-27 work programme (42 projects with their KPI targets, milestones and team), or add a project by hand.</p>
                <Button className="mt-3" onClick={loadProgramme} busy={busy}>Load the FY 2026-27 programme</Button></>
            : 'An admin is mapping people to projects. Check back soon.'}
        </Empty>
      )}
      {byGroup(projects).map(({ group, items }) => (
        <Section key={group} title={group}>
          <Panel><ul className="divide-y divide-line">
            {items.map((p) => (
              <li key={p.id}>
                <Link href={`/projects/${p.id}`} className="block px-4 py-3 hover:bg-wash/60">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium"><span className="text-muted">{p.code}</span> · {p.name}</p>
                      <p className="text-sm text-muted">
                        {p.kpiCount} {p.kpiCount === 1 ? 'KPI' : 'KPIs'}
                        {p.milestones.total > 0 && <> · {p.milestones.done}/{p.milestones.total} milestones</>}
                        {' · '}{p.members > 0 ? `${p.members} on the team` : 'no one mapped'}
                        {p.budget && p.budget !== '—' && <> · {p.budget}</>}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {admin && p.pending > 0 && <Badge tone="marigold">{p.pending} to review</Badge>}
                      {p.kpiPct !== null && <PctBadge pct={p.kpiPct} />}
                      {p.status === 'locked' ? <Badge tone="kumkum">Locked</Badge> : p.completed ? <Badge tone="peacock">Completed</Badge> : null}
                    </div>
                  </div>
                  {p.kpiPct !== null && <div className="mt-2"><Bar pct={p.kpiPct} label={`${p.name} KPI progress`} /></div>}
                </Link>
              </li>
            ))}
          </ul></Panel>
        </Section>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ completed reports

function CompletedReports() {
  const { data, error, loading, reload } = useApi<CompletedProject[]>('/projects/completed');
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNote error={error} retry={reload} />;
  if (!data?.length) return <Empty title="No completed project yet">When every milestone of a project is approved, its consolidated report appears here for everyone.</Empty>;
  return (
    <div className="space-y-4">
      {data.map((p) => (
        <Panel key={p.id} className="p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-xl font-semibold"><Link href={`/projects/${p.id}`} className="hover:underline">{p.code} · {p.name}</Link></h2>
            <div className="flex gap-2"><Badge tone="neutral">{p.fy}</Badge><Badge tone="peacock">Completed</Badge></div>
          </div>
          <p className="mt-1 text-sm text-muted">Team: {p.members.map((m) => `${m.fullName} (${m.designation})`).join(', ') || 'no one mapped'}</p>
          {p.kpis.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">KPI achievement</h3>
              <ul className="divide-y divide-line/70">
                {p.kpis.map((k) => (
                  <li key={k.id} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
                    <span className="min-w-0 flex-1">{k.name}</span>
                    <span>{k.approved} / {k.target} {k.unit}</span>
                    <PctBadge pct={k.pct} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          <h3 className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-muted">Milestone reports</h3>
          <ul className="space-y-2">
            {p.milestones.map((m) => (
              <li key={m.id} className="rounded-lg bg-wash/70 p-3 text-sm">
                <div className="flex flex-wrap justify-between gap-1"><span className="font-medium">{m.title}</span>{m.due && <span className="text-muted">Due {fmtDate(m.due)}</span>}</div>
                {m.report
                  ? <p className="mt-1 whitespace-pre-line text-muted">{m.report.text}<span className="mt-1 block text-xs">{m.report.byName ?? 'Unknown'}{m.report.at && `, ${fmtDate(m.report.at)}`}</span></p>
                  : <p className="mt-1 text-xs text-muted">Completed by an admin, with no member report.</p>}
              </li>
            ))}
          </ul>
        </Panel>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ resources: who is on what

function Resources({ admin, onChanged }: { admin: boolean; onChanged: () => void }) {
  const toast = useToast();
  const { data, error, loading, reload } = useApi<ProjectMapping>('/projects/mapping');
  const [mode, setMode] = useState<'project' | 'person'>('project');
  const [pick, setPick] = useState<Record<string, { employeeId: string; designation: string }>>({});

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNote error={error} retry={reload} />;
  if (!data) return null;

  async function act(fn: () => Promise<unknown>) {
    try { await fn(); await reload(); onChanged(); } catch (e) { toast(errorText(e), 'error'); }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-prose text-sm text-muted">Who is mapped to which project, and in what role.{admin && ' Re-map any time as teams change.'}</p>
        <div className="flex gap-1" role="group" aria-label="View">
          {([['project', 'By project'], ['person', 'By person']] as const).map(([k, l]) => (
            <Button key={k} size="sm" variant={mode === k ? 'primary' : 'secondary'} onClick={() => setMode(k)} aria-pressed={mode === k}>{l}</Button>
          ))}
        </div>
      </div>

      {mode === 'project' && byGroup(data.projects).map(({ group, items }) => (
        <Section key={group} title={group}>
          <div className="space-y-2">
            {items.map((p) => {
              const sel = pick[p.id] ?? { employeeId: '', designation: 'Project Associate' };
              const locked = p.status === 'locked';
              const onTeam = new Set(p.members.map((m) => m.employeeId));
              return (
                <Panel key={p.id} className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link href={`/projects/${p.id}`} className="font-medium hover:underline"><span className="text-muted">{p.code}</span> · {p.name}</Link>
                    <span className="text-sm text-muted">{p.members.length ? `${p.members.length} mapped` : 'No one mapped'}{locked && ' · locked'}</span>
                  </div>
                  {p.members.length > 0 && (
                    <ul className="mt-2 flex flex-wrap gap-2">
                      {p.members.map((m) => (
                        <li key={m.employeeId} className="inline-flex items-center gap-1 rounded-full bg-peacock-tint px-2.5 py-1 text-xs font-medium text-peacock-dark">
                          {m.fullName} · {m.designation}
                          {admin && !locked && (
                            <button type="button" aria-label={`Remove ${m.fullName} from ${p.name}`} className="ml-1 text-kumkum"
                              onClick={() => act(() => api(`/projects/${p.id}/members/${m.employeeId}`, { method: 'DELETE' }))}>×</button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {admin && !locked && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Select aria-label={`Person to add to ${p.name}`} className="w-48" value={sel.employeeId} onChange={(e) => setPick({ ...pick, [p.id]: { ...sel, employeeId: e.target.value } })}>
                        <option value="">Choose a person…</option>
                        {data.people.filter((x) => !onTeam.has(x.id)).map((x) => <option key={x.id} value={x.id}>{x.fullName}</option>)}
                      </Select>
                      <Select aria-label="Role" className="w-44" value={sel.designation} onChange={(e) => setPick({ ...pick, [p.id]: { ...sel, designation: e.target.value } })}>
                        {data.designations.map((d) => <option key={d}>{d}</option>)}
                      </Select>
                      <Button size="sm" disabled={!sel.employeeId}
                        onClick={() => act(async () => { await api(`/projects/${p.id}/members/${sel.employeeId}`, { method: 'PUT', body: { designation: sel.designation } }); setPick({ ...pick, [p.id]: { employeeId: '', designation: sel.designation } }); })}>Map</Button>
                    </div>
                  )}
                </Panel>
              );
            })}
          </div>
        </Section>
      ))}

      {mode === 'person' && (
        <div className="space-y-2">
          {data.people.map((person) => (
            <Panel key={person.id} className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link href={`/people/${person.id}`} className="font-medium hover:underline">{person.fullName}</Link>
                {person.projects.length === 0 ? <Badge tone="marigold">Not on any project</Badge> : <Badge tone="peacock">{person.projects.length} {person.projects.length === 1 ? 'project' : 'projects'}</Badge>}
              </div>
              {person.projects.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-2">
                  {person.projects.map((p) => (
                    <li key={p.id}><Link href={`/projects/${p.id}`} className="inline-flex items-center gap-1 rounded-full bg-wash px-2.5 py-1 text-xs hover:bg-line/60">{p.code} {p.name.length > 32 ? `${p.name.slice(0, 32)}…` : p.name} · <RoleChip>{p.designation}</RoleChip></Link></li>
                  ))}
                </ul>
              )}
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ new project

function NewProject({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ code: '', group: GROUPS[0], name: '', budget: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/projects', { body: { ...form, budget: form.budget || undefined } });
      toast('Project added');
      setForm({ code: '', group: GROUPS[0], name: '', budget: '' });
      onClose();
      onCreated();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="New project">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Code" hint="A short code such as C11 or H7."><Input required maxLength={30} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
        <Field label="Name"><Input required maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Group"><Select value={form.group} onChange={(e) => setForm({ ...form, group: e.target.value })}>{GROUPS.map((g) => <option key={g}>{g}</option>)}</Select></Field>
        <Field label="Budget" hint="Optional, as you would write it, for example ₹50 L."><Input maxLength={60} value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} /></Field>
        {error && <Notice tone="kumkum">{error}</Notice>}
        <FormActions><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" busy={busy}>Add project</Button></FormActions>
      </form>
    </Dialog>
  );
}
