'use client';

import { useRef, useState } from 'react';
import { api, errorText, useApi } from '@/lib/api';
import { addDays, fmtDateTime, todayIst } from '@/lib/dates';
import { Badge, Button, ErrorNote, Field, Input, Loading, Notice, Panel, Section, useToast } from './ui';

interface Status {
  configured: boolean;
  server: string | null;
  lookbackDays: number;
  devices: { serial: string; lastCheckedAt: string | null; lastOkAt: string | null; lastError: string | null }[];
  people: { biometric: number; selfie: number };
  runs: {
    id: string; source: 'file' | 'api'; startedAt: string; status: 'running' | 'done' | 'failed'; device: string | null; from: string | null; to: string | null;
    rowsRead: number; inserted: number; duplicates: number; unmatched: number; rejected: number; message: string | null; by: string | null;
  }[];
  unmatched: { code: string; punches: number; lastAt: string }[];
}

interface ImportResult { rowsRead: number; inserted: number; duplicates: number; unmatched: number; rejected: number; daysUpdated: number }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function describe(r: ImportResult): string {
  const parts = [`${plural(r.inserted, 'new punch', 'new punches')}${r.unmatched ? ` (${r.unmatched} for codes nobody has yet)` : ''}`];
  if (r.duplicates) parts.push(`${r.duplicates} already there`);
  if (r.rejected) parts.push(`${plural(r.rejected, 'row')} could not be read`);
  return `Read ${plural(r.rowsRead, 'row')}: ${parts.join(', ')}. ${plural(r.daysUpdated, 'attendance day')} updated.`;
}

/** The head-office biometric machine: connection, importing a file, codes nobody owns, recent imports. */
export function BiometricSetup() {
  const toast = useToast();
  const status = useApi<Status>('/admin/attendance/biometric');
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [serial, setSerial] = useState('');
  const [busy, setBusy] = useState<'' | 'import' | 'sync' | 'rebuild'>('');
  const [result, setResult] = useState<{ tone: 'peacock' | 'kumkum' | 'marigold'; text: string } | null>(null);
  const [range, setRange] = useState({ from: addDays(todayIst(), -7), to: todayIst() });
  const s = status.data;

  async function importFile(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy('import');
    setResult(null);
    try {
      const text = await file.text();
      const r = await api<ImportResult>(`/admin/attendance/biometric/import${serial.trim() ? `?serial=${encodeURIComponent(serial.trim())}` : ''}`, { method: 'POST', body: text, text: true });
      setResult({ tone: r.rejected || r.unmatched ? 'marigold' : 'peacock', text: describe(r) });
      setFile(null);
      setSerial('');
      if (fileRef.current) fileRef.current.value = '';
      await status.reload();
    } catch (err) {
      setResult({ tone: 'kumkum', text: errorText(err) });
      await status.reload();
    } finally {
      setBusy('');
    }
  }

  async function syncNow() {
    setBusy('sync');
    setResult(null);
    try {
      const r = await api<{ devices: number; inserted: number; failed: number; messages: string[] }>('/admin/attendance/biometric/sync', { method: 'POST' });
      if (r.failed) setResult({ tone: 'kumkum', text: `${r.failed} of ${plural(r.devices, 'machine')} could not be reached. ${r.messages.join(' ')}` });
      else setResult({ tone: 'peacock', text: `Checked ${plural(r.devices, 'machine')}: ${plural(r.inserted, 'new punch', 'new punches')}.` });
      await status.reload();
    } catch (err) {
      setResult({ tone: 'kumkum', text: errorText(err) });
    } finally {
      setBusy('');
    }
  }

  async function rebuild(e: React.FormEvent) {
    e.preventDefault();
    setBusy('rebuild');
    try {
      const r = await api<{ people: number }>('/admin/attendance/biometric/rebuild', { method: 'POST', body: range });
      toast(`Worked out again for ${plural(r.people, 'person', 'people')}`);
      await status.reload();
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy('');
    }
  }

  return (
    <Section title="Biometric machine at head office">
      <p className="mb-4 max-w-prose text-sm text-muted">
        People set to the biometric machine (under Employees) get their attendance from the machine&apos;s punches: the first punch of the day is the check-in and the last is the check-out.
        Everyone else, and everyone on an approved on-duty day, checks in here with a selfie.
      </p>
      {status.loading && !s && <Loading />}
      {status.error && <ErrorNote error={status.error} retry={status.reload} />}
      {s && (
        <div className="space-y-4">
          <Panel className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-medium">
                  {s.configured ? <>Connected to <span className="font-mono text-sm">{s.server}</span></> : 'Not connected to the machine’s server'}
                </p>
                <p className="mt-0.5 text-sm text-muted">
                  {plural(s.people.biometric, 'person', 'people')} on the machine, {s.people.selfie} on selfie.
                  {s.configured && ` The portal asks the machine for the last ${plural(s.lookbackDays, 'day')} every 15 minutes.`}
                </p>
              </div>
              {s.configured && <Button size="sm" variant="secondary" busy={busy === 'sync'} onClick={() => void syncNow()}>Pull from machine now</Button>}
            </div>
            {!s.configured && (
              <p className="mt-3 text-sm text-muted">
                You can still bring punches in with a file below. To pull them automatically, the technical team sets the machine server&apos;s address, user and serial numbers (see the README).
              </p>
            )}
            {s.devices.length > 0 && (
              <ul className="mt-3 divide-y divide-line border-t border-line text-sm">
                {s.devices.map((d) => (
                  <li key={d.serial} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
                    <span className="font-mono">{d.serial}</span>
                    <span className="text-muted">
                      {d.lastError ? <Badge tone="kumkum">Problem</Badge> : d.lastOkAt ? <Badge tone="peacock">Working</Badge> : <Badge>Not asked yet</Badge>}{' '}
                      {d.lastOkAt ? `Last answered ${fmtDateTime(d.lastOkAt)}` : ''}
                    </span>
                    {d.lastError && <span className="w-full text-kumkum">{d.lastError}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel className="p-4">
            <form onSubmit={importFile} className="space-y-3">
              <p className="font-medium">Import punches from a file</p>
              <p className="max-w-prose text-sm text-muted">
                Export the punch log from the machine&apos;s software (a CSV or text file with the person&apos;s code and the date and time of each punch) and choose it here.
                Importing the same file twice does no harm.
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <Field label="File">
                  <input ref={fileRef} type="file" accept=".csv,.txt,.log,text/plain,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    className="block w-full max-w-xs text-sm file:mr-3 file:rounded-lg file:border file:border-line file:bg-surface file:px-3 file:py-2 file:text-sm file:font-medium hover:file:bg-wash" />
                </Field>
                <Field label="Machine serial number" hint="Optional, if the file does not say."><Input value={serial} onChange={(e) => setSerial(e.target.value)} className="w-56" /></Field>
                <Button type="submit" busy={busy === 'import'} disabled={!file}>Import</Button>
              </div>
            </form>
          </Panel>

          {result && <Notice tone={result.tone}>{result.text}</Notice>}

          {s.unmatched.length > 0 && (
            <Panel className="p-4">
              <p className="font-medium">Codes nobody has yet</p>
              <p className="mb-2 max-w-prose text-sm text-muted">The machine reported these codes, but no employee has them. Enter each one against the right person under Employees, then work those days out again below.</p>
              <ul className="divide-y divide-line text-sm">
                {s.unmatched.map((u) => (
                  <li key={u.code} className="flex flex-wrap justify-between gap-2 py-1.5">
                    <span className="font-mono">{u.code}</span>
                    <span className="text-muted">{plural(u.punches, 'punch', 'punches')}, last {fmtDateTime(u.lastAt)}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel className="p-4">
            <form onSubmit={rebuild} className="flex flex-wrap items-end gap-3">
              <div className="min-w-48 flex-1">
                <p className="font-medium">Work days out again</p>
                <p className="max-w-prose text-sm text-muted">After changing someone&apos;s code or method, rebuild their days from the punches already stored.</p>
              </div>
              <Field label="From"><Input type="date" required value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} className="w-40" /></Field>
              <Field label="To"><Input type="date" required value={range.to} min={range.from} max={todayIst()} onChange={(e) => setRange({ ...range, to: e.target.value })} className="w-40" /></Field>
              <Button type="submit" variant="secondary" busy={busy === 'rebuild'}>Rebuild</Button>
            </form>
          </Panel>

          {s.runs.length > 0 && (
            <Panel>
              <p className="border-b border-line px-4 py-3 font-medium">Recent imports</p>
              <ul className="divide-y divide-line text-sm">
                {s.runs.map((r) => (
                  <li key={r.id} className="px-4 py-2.5">
                    <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-medium">{fmtDateTime(r.startedAt)}</span>
                      <Badge tone={r.status === 'failed' ? 'kumkum' : r.status === 'done' ? 'peacock' : 'neutral'}>{r.status === 'failed' ? 'Failed' : r.status === 'done' ? 'Done' : 'Running'}</Badge>
                      <span className="text-muted">{r.source === 'file' ? `File${r.by ? `, by ${r.by}` : ''}` : `Machine ${r.device ?? ''}`}</span>
                    </p>
                    <p className="text-muted">
                      {r.status === 'failed' ? r.message : `${plural(r.rowsRead, 'row')} read, ${r.inserted} new, ${r.duplicates} already there${r.unmatched ? `, ${r.unmatched} for unknown codes` : ''}${r.rejected ? `, ${r.rejected} unreadable` : ''}.`}
                    </p>
                    {r.status !== 'failed' && r.message && <p className="text-muted">{r.message}</p>}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
      )}
    </Section>
  );
}
