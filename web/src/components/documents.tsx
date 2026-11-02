'use client';

import { useRef, useState } from 'react';
import { api, errorText, useApi } from '@/lib/api';
import { fmtDate, relative, todayIst } from '@/lib/dates';
import { fmtBytes } from '@/lib/labels';
import { useSession } from '@/lib/session';
import type { DocumentView } from '@/lib/types';
import { Icon } from './icons';
import { Badge, Button, Check, Dialog, Empty, ErrorNote, Field, FormActions, Input, Loading, Notice, Panel, Select, useToast } from './ui';

interface Category { code: string; name: string; expiryTracked: boolean }

const ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx';
const MAX_BYTES = 10 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** A person's documents with upload, download, rename and removal. HR may add to anyone's record. */
export function DocumentsPanel({ employeeId, ownerName }: { employeeId: string; ownerName?: string }) {
  const { me, isHr } = useSession();
  const toast = useToast();
  const list = useApi<DocumentView[]>(`/employees/${employeeId}/documents`);
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState<DocumentView | null>(null);
  const [removing, setRemoving] = useState<DocumentView | null>(null);
  const own = me?.id === employeeId;

  async function download(d: DocumentView) {
    try {
      const { url } = await api<{ url: string }>(`/documents/${d.id}/download-url`);
      window.location.assign(url);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  async function remove(d: DocumentView) {
    try {
      await api(`/documents/${d.id}`, { method: 'DELETE' });
      toast('Document removed');
      setRemoving(null);
      await list.reload();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-prose text-sm text-muted">
          {own ? 'Your ID proofs, certificates and letters. Only you and HR can open them.' : `Documents on ${ownerName ?? 'this'} record. Managers cannot see these; HR can.`}
        </p>
        {(own || isHr) && <Button onClick={() => setUploading(true)}><Icon name="upload" className="size-4" />Add document</Button>}
      </div>

      {list.loading && !list.data && <Loading />}
      {list.error && <ErrorNote error={list.error} retry={list.reload} />}
      {list.data?.length === 0 && <Empty title="No documents yet">{own ? 'Add your ID proof, address proof and certificates here.' : 'Nothing has been uploaded.'}</Empty>}
      {list.data && list.data.length > 0 && (
        <Panel>
          <ul className="divide-y divide-line">
            {list.data.map((d) => {
              const canChange = isHr || (own && d.uploadedBy.id === me?.id);
              return (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <Icon name="file" className="mt-0.5 size-5 shrink-0 text-muted" />
                    <div className="min-w-0">
                      <p className="truncate font-medium">{d.title}</p>
                      <p className="text-sm text-muted">{d.category.name} · {d.fileName} · {fmtBytes(d.sizeBytes)}</p>
                      <p className="text-xs text-muted">Added {relative(d.createdAt)} by {d.uploadedBy.id === me?.id ? 'you' : d.uploadedBy.name}</p>
                      <p className="mt-1 flex flex-wrap gap-1.5">
                        {d.visibility === 'hr_only' && <Badge tone="indigo">HR only</Badge>}
                        {d.expiry === 'expired' && <Badge tone="kumkum">Expired {fmtDate(d.expiresOn!)}</Badge>}
                        {d.expiry === 'expiring_soon' && <Badge tone="marigold">Expires {fmtDate(d.expiresOn!)}</Badge>}
                        {d.expiry === 'valid' && <Badge>Valid until {fmtDate(d.expiresOn!)}</Badge>}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="secondary" onClick={() => void download(d)}><Icon name="download" className="size-4" />Download</Button>
                    {canChange && <Button size="sm" variant="ghost" onClick={() => setEditing(d)} aria-label={`Edit ${d.title}`}><Icon name="edit" className="size-4" /></Button>}
                    {canChange && <Button size="sm" variant="ghost" onClick={() => setRemoving(d)} aria-label={`Remove ${d.title}`}><Icon name="trash" className="size-4" /></Button>}
                  </div>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      <UploadDialog open={uploading} employeeId={employeeId} own={own} onClose={() => setUploading(false)} onDone={() => { setUploading(false); void list.reload(); }} />
      <EditDialog doc={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); void list.reload(); }} />
      <Dialog open={!!removing} onClose={() => setRemoving(null)} title="Remove this document?">
        <p className="text-sm">“{removing?.title}” and its file will be deleted. A record that it existed is kept.</p>
        <FormActions>
          <Button variant="secondary" onClick={() => setRemoving(null)}>Keep it</Button>
          <Button variant="danger" onClick={() => removing && void remove(removing)}>Remove</Button>
        </FormActions>
      </Dialog>
    </div>
  );
}

function UploadDialog({ open, employeeId, own, onClose, onDone }: { open: boolean; employeeId: string; own: boolean; onClose: () => void; onDone: () => void }) {
  const { isHr } = useSession();
  const toast = useToast();
  const categories = useApi<Category[]>(open ? '/documents/categories' : null);
  const [form, setForm] = useState({ categoryCode: '', title: '', expiresOn: '', hrOnly: false });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [wasOpen, setWasOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  if (open && !wasOpen) {
    setWasOpen(true);
    setForm({ categoryCode: '', title: '', expiresOn: '', hrOnly: false });
    setFile(null);
    setError('');
  }
  if (!open && wasOpen) setWasOpen(false);

  const category = categories.data?.find((c) => c.code === form.categoryCode);

  function pick(f: File | null) {
    setError('');
    if (f && f.size > MAX_BYTES) { setFile(null); return setError(`That file is ${fmtBytes(f.size)}. The limit is 10 MB.`); }
    setFile(f);
    if (f && !form.title) setForm((s) => ({ ...s, title: f.name.replace(/\.[^.]+$/, '') }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return setError('Choose a file to upload.');
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    const contentType = MIME_BY_EXT[ext];
    if (!contentType) return setError('This file type is not accepted. Use PDF, JPG, PNG, WebP, Word or Excel.');
    setBusy(true);
    setError('');
    try {
      const created = await api<{ document: DocumentView; upload: { method: string; url: string; headers: Record<string, string> } }>('/documents', {
        method: 'POST',
        body: {
          employeeId: own ? undefined : employeeId, categoryCode: form.categoryCode, title: form.title, fileName: file.name, contentType, sizeBytes: file.size,
          expiresOn: form.expiresOn || undefined, visibility: isHr && form.hrOnly ? 'hr_only' : undefined,
        },
      });
      // The file goes straight to storage (S3 in AWS). In development the API itself receives it.
      const sameOrigin = created.upload.url.startsWith('/');
      const sent = await fetch(created.upload.url, {
        method: created.upload.method, headers: created.upload.headers, body: file, credentials: sameOrigin ? 'same-origin' : 'omit',
      });
      if (!sent.ok) throw new Error('The file could not be uploaded. Check your connection and try again.');
      await api(`/documents/${created.document.id}/complete`, { method: 'POST' });
      toast('Document added');
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Add a document">
      <form onSubmit={submit} className="space-y-4">
        <Field label="File" hint="PDF, JPG, PNG, WebP, Word or Excel. Up to 10 MB.">
          <input ref={input} type="file" accept={ACCEPT} onChange={(e) => pick(e.target.files?.[0] ?? null)}
            className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-peacock-tint file:px-3 file:py-2 file:font-medium file:text-peacock-dark hover:file:bg-peacock-tint/70" />
        </Field>
        <Field label="Type of document">
          <Select required value={form.categoryCode} onChange={(e) => setForm({ ...form, categoryCode: e.target.value })}>
            <option value="" disabled>Choose…</option>
            {categories.data?.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Title"><Input required maxLength={160} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
        {(category?.expiryTracked || form.expiresOn) && (
          <Field label="Valid until" hint="You will be reminded a month before it runs out."><Input type="date" min={todayIst()} value={form.expiresOn} onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} /></Field>
        )}
        {isHr && <Check label="Visible to HR only" checked={form.hrOnly} onChange={(e) => setForm({ ...form, hrOnly: e.target.checked })} />}
        {error && <Notice tone="kumkum">{error}</Notice>}
        <FormActions>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" busy={busy}>Upload</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

function EditDialog({ doc, onClose, onDone }: { doc: DocumentView | null; onClose: () => void; onDone: () => void }) {
  const { isHr } = useSession();
  const toast = useToast();
  const [form, setForm] = useState({ title: '', expiresOn: '', hrOnly: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [seen, setSeen] = useState<string | null>(null);

  if (doc && doc.id !== seen) {
    setSeen(doc.id);
    setForm({ title: doc.title, expiresOn: doc.expiresOn ?? '', hrOnly: doc.visibility === 'hr_only' });
    setError('');
  }
  if (!doc && seen) setSeen(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!doc) return;
    setBusy(true);
    setError('');
    try {
      await api(`/documents/${doc.id}`, {
        method: 'PATCH',
        body: { title: form.title, expiresOn: form.expiresOn || null, ...(isHr ? { visibility: form.hrOnly ? 'hr_only' : 'employee_and_hr' } : {}) },
      });
      toast('Document updated');
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!doc} onClose={onClose} title="Edit document">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Title"><Input required maxLength={160} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
        <Field label="Valid until"><Input type="date" value={form.expiresOn} onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} /></Field>
        {isHr && <Check label="Visible to HR only" checked={form.hrOnly} onChange={(e) => setForm({ ...form, hrOnly: e.target.checked })} />}
        {error && <Notice tone="kumkum">{error}</Notice>}
        <FormActions>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" busy={busy}>Save</Button>
        </FormActions>
      </form>
    </Dialog>
  );
}
