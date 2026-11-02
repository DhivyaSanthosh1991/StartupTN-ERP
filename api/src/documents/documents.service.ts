import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { Injectable, StreamableFile } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { AuthUser, hasRole } from '../common/auth.types';
import { addDays, todayIst } from '../common/dates';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { Db } from '../db/db.service';
import { DOWNLOAD_URL_TTL_SECONDS, StorageService, UploadTooLargeError, contentDisposition } from './storage.service';

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const EXPIRY_WARNING_DAYS = 30;

/** What may be stored, and the extensions that go with each type. Anything that a browser could run (HTML, SVG, scripts) is out. */
export const ALLOWED_TYPES: Record<string, string[]> = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'application/msword': ['doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.ms-excel': ['xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
};

export interface CreateDocumentInput {
  employeeId?: string;
  categoryCode: string;
  title: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  expiresOn?: string | null;
  visibility?: 'employee_and_hr' | 'hr_only';
}

const DOCUMENT_SQL = `
  select d.*, c.code as category_code, c.name as category_name, c.expiry_tracked,
         u.full_name as uploaded_by_name, e.full_name as employee_name, e.emp_code
    from documents d
    join document_categories c on c.id = d.category_id
    join employees u on u.id = d.uploaded_by
    join employees e on e.id = d.employee_id`;

@Injectable()
export class DocumentsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  async categories() {
    const rows = await this.db.rows('select code, name, expiry_tracked from document_categories order by sort_order, name');
    return rows.map((r) => ({ code: r.code as string, name: r.name as string, expiryTracked: r.expiry_tracked as boolean }));
  }

  // ---------------------------------------------------------------- listing

  /** A person's documents: their own (without HR-only items), or anyone's for HR. */
  async list(viewer: AuthUser, employeeId: string) {
    const isHr = hasRole(viewer, 'hr_admin');
    if (employeeId !== viewer.id && !isHr) throw forbidden('FORBIDDEN', 'You do not have access to these documents');
    const rows = await this.db.rows(
      `${DOCUMENT_SQL} where d.employee_id = $1 and d.status = 'available' and ($2 or d.visibility = 'employee_and_hr')
        order by c.sort_order, d.created_at desc`, [employeeId, isHr]);
    return rows.map(view);
  }

  /** Documents that have expired or will within `days`: yours, or everyone's when `all` and HR. */
  async expiring(viewer: AuthUser, days: number, all: boolean) {
    const isHr = hasRole(viewer, 'hr_admin');
    if (all && !isHr) throw forbidden('FORBIDDEN', 'Only HR can see everyone\'s documents');
    const rows = await this.db.rows(
      `${DOCUMENT_SQL}
        where d.status = 'available' and d.expires_on is not null and d.expires_on <= $1
          and ($2::boolean or (d.employee_id = $3 and d.visibility = 'employee_and_hr'))
          and e.status = 'active'
        order by d.expires_on, e.full_name`, [addDays(todayIst(), days), all, viewer.id]);
    return rows.map(view);
  }

  // ----------------------------------------------------------------- upload

  /**
   * Step 1 of an upload: records the document as pending and hands back where to send the bytes.
   * Employees add to their own records; HR can add for anyone and can keep an item HR-only.
   */
  async create(viewer: AuthUser, input: CreateDocumentInput) {
    const isHr = hasRole(viewer, 'hr_admin');
    const employeeId = input.employeeId ?? viewer.id;
    if (employeeId !== viewer.id && !isHr) throw forbidden('FORBIDDEN', 'You can only add documents to your own record');
    const visibility = isHr ? (input.visibility ?? 'employee_and_hr') : 'employee_and_hr';

    const fileName = sanitizeFileName(input.fileName);
    const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
    const allowedExts = ALLOWED_TYPES[input.contentType];
    if (!allowedExts) throw badRequest('FILE_TYPE_NOT_ALLOWED', 'Only PDF, image, Word and Excel files can be stored');
    if (!allowedExts.includes(ext)) throw badRequest('FILE_TYPE_MISMATCH', 'The file name does not match its type');
    if (input.sizeBytes <= 0) throw badRequest('EMPTY_FILE', 'The file is empty');
    if (input.sizeBytes > MAX_DOCUMENT_BYTES) {
      throw badRequest('FILE_TOO_LARGE', `Files can be at most ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB`);
    }

    const category = await this.db.one('select id, code from document_categories where code = $1', [input.categoryCode]);
    if (!category) throw badRequest('CATEGORY_INVALID', 'Unknown document category');
    const owner = await this.db.one(`select 1 as x from employees where id = $1`, [employeeId]);
    if (!owner) throw notFound('EMPLOYEE_NOT_FOUND', 'Employee not found');

    const id = randomUUID();
    const key = `employees/${employeeId}/${id}`;
    await this.db.tx(async (q) => {
      await q.query(
        `insert into documents (id, employee_id, category_id, title, storage_key, file_name, content_type, size_bytes, expires_on, visibility, uploaded_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, employeeId, category.id, input.title, key, fileName, input.contentType, input.sizeBytes, input.expiresOn ?? null, visibility, viewer.id]);
      await this.audit.record({ actorId: viewer.id, action: 'document.create', entityType: 'document', entityId: id,
        after: { employeeId, category: category.code, fileName, sizeBytes: input.sizeBytes, visibility } }, q);
    });

    const upload = await this.storage.uploadTarget(key, input.contentType, input.sizeBytes, `/api/documents/${id}/content`);
    return { document: await this.getOne(id), upload };
  }

  /** Local driver: receives the file bytes. With S3 the browser sends the file to S3 instead. */
  async uploadLocal(viewer: AuthUser, id: string, req: Readable & { headers: Record<string, string | string[] | undefined> }) {
    if (this.storage.driver !== 'local') throw notFound('NOT_FOUND', 'Not found');
    const doc = await this.pendingOwnedBy(viewer, id);

    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== doc.content_type) throw badRequest('CONTENT_TYPE_MISMATCH', 'The file type does not match what was announced');
    const length = Number(req.headers['content-length']);
    if (!Number.isFinite(length)) throw badRequest('LENGTH_REQUIRED', 'The file size must be sent with the upload');
    if (length !== doc.size_bytes) throw badRequest('SIZE_MISMATCH', 'The file size does not match what was announced');

    try {
      const written = await this.storage.saveLocal(doc.storage_key, req, doc.size_bytes);
      if (written !== doc.size_bytes) {
        await this.storage.delete(doc.storage_key);
        throw badRequest('SIZE_MISMATCH', 'The upload was incomplete');
      }
    } catch (err) {
      if (err instanceof UploadTooLargeError) throw badRequest('SIZE_MISMATCH', 'The file is larger than announced');
      throw err;
    }
  }

  /** Step 3: checks that the file really arrived, then makes the document visible. */
  async complete(viewer: AuthUser, id: string) {
    const doc = await this.db.one('select * from documents where id = $1', [id]);
    if (!doc || (doc.uploaded_by !== viewer.id && !hasRole(viewer, 'hr_admin'))) throw notFound('DOCUMENT_NOT_FOUND', 'Document not found');
    if (doc.status === 'available') return this.getOne(id);
    if (doc.status !== 'pending_upload') throw conflict('NOT_PENDING', 'This upload is no longer open');

    const stored = await this.storage.head(doc.storage_key);
    if (!stored) throw conflict('UPLOAD_MISSING', 'The file has not arrived. Please upload it again');
    if (stored.size !== doc.size_bytes) {
      await this.storage.delete(doc.storage_key);
      throw conflict('SIZE_MISMATCH', 'The stored file is not the size announced. Please upload it again');
    }
    await this.db.tx(async (q) => {
      await q.query(`update documents set status = 'available' where id = $1 and status = 'pending_upload'`, [id]);
      await this.audit.record({ actorId: viewer.id, action: 'document.upload', entityType: 'document', entityId: id, after: { employeeId: doc.employee_id } }, q);
    });
    return this.getOne(id);
  }

  private async pendingOwnedBy(viewer: AuthUser, id: string) {
    const doc = await this.db.one('select * from documents where id = $1', [id]);
    if (!doc || doc.uploaded_by !== viewer.id) throw notFound('DOCUMENT_NOT_FOUND', 'Document not found');
    if (doc.status !== 'pending_upload') throw conflict('NOT_PENDING', 'This upload is no longer open');
    return doc;
  }

  // --------------------------------------------------------------- download

  async downloadUrl(viewer: AuthUser, id: string) {
    const doc = await this.downloadable(viewer, id);
    const url = await this.storage.downloadUrl(doc.storage_key, doc.file_name, doc.content_type, `/api/documents/${id}/file`);
    return { url, fileName: doc.file_name as string, expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS };
  }

  /** Local driver: streams the file through the API, after the same checks. */
  async streamLocal(viewer: AuthUser, id: string): Promise<StreamableFile> {
    if (this.storage.driver !== 'local') throw notFound('NOT_FOUND', 'Not found');
    const doc = await this.downloadable(viewer, id);
    return new StreamableFile(this.storage.openLocal(doc.storage_key), {
      type: doc.content_type, disposition: contentDisposition(doc.file_name), length: doc.size_bytes,
    });
  }

  /** Access check + audit trail. Documents someone may not see look the same as ones that do not exist. */
  private async downloadable(viewer: AuthUser, id: string) {
    const doc = await this.db.one(`select * from documents where id = $1 and status = 'available'`, [id]);
    const isHr = hasRole(viewer, 'hr_admin');
    const mayRead = !!doc && (isHr || (doc.employee_id === viewer.id && doc.visibility === 'employee_and_hr'));
    if (!doc || !mayRead) throw notFound('DOCUMENT_NOT_FOUND', 'Document not found');
    await this.audit.record({ actorId: viewer.id, action: 'document.download', entityType: 'document', entityId: id, after: { employeeId: doc.employee_id } });
    return doc;
  }

  // ----------------------------------------------------------- change/remove

  async update(viewer: AuthUser, id: string, patch: { title?: string; expiresOn?: string | null; visibility?: 'employee_and_hr' | 'hr_only' }) {
    const doc = await this.db.one(`select * from documents where id = $1 and status = 'available'`, [id]);
    const isHr = hasRole(viewer, 'hr_admin');
    if (!doc || (!isHr && (doc.employee_id !== viewer.id || doc.uploaded_by !== viewer.id))) throw notFound('DOCUMENT_NOT_FOUND', 'Document not found');
    if (patch.visibility !== undefined && !isHr) throw forbidden('FORBIDDEN', 'Only HR can change who sees a document');

    const sets: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown) => { values.push(value); sets.push(`${column} = $${values.length}`); };
    if (patch.title !== undefined) add('title', patch.title);
    if (patch.expiresOn !== undefined) add('expires_on', patch.expiresOn);
    if (patch.visibility !== undefined) add('visibility', patch.visibility);
    if (sets.length) {
      values.push(id);
      await this.db.tx(async (q) => {
        await q.query(`update documents set ${sets.join(', ')} where id = $${values.length}`, values);
        await this.audit.record({ actorId: viewer.id, action: 'document.update', entityType: 'document', entityId: id,
          before: { title: doc.title, expiresOn: doc.expires_on, visibility: doc.visibility }, after: patch }, q);
      });
    }
    return this.getOne(id);
  }

  /**
   * Deletes the file and keeps a record that a document existed. Employees can remove only what they
   * uploaded themselves; anything HR added to their record is for HR to remove.
   */
  async remove(viewer: AuthUser, id: string) {
    const doc = await this.db.one(`select * from documents where id = $1 and status <> 'deleted'`, [id]);
    const isHr = hasRole(viewer, 'hr_admin');
    if (!doc || (!isHr && (doc.employee_id !== viewer.id || doc.uploaded_by !== viewer.id || doc.visibility !== 'employee_and_hr'))) {
      throw notFound('DOCUMENT_NOT_FOUND', 'Document not found');
    }
    await this.db.tx(async (q) => {
      await q.query(`update documents set status = 'deleted', deleted_at = now() where id = $1`, [id]);
      await this.audit.record({ actorId: viewer.id, action: 'document.delete', entityType: 'document', entityId: id,
        before: { employeeId: doc.employee_id, title: doc.title, fileName: doc.file_name } }, q);
    });
    await this.storage.delete(doc.storage_key).catch(() => undefined);
  }

  /** Uploads that were started but never completed are cleared after a day. */
  async purgeAbandoned(now: Date = new Date()): Promise<{ removed: number }> {
    const stale = await this.db.rows(
      `select id, storage_key from documents where status = 'pending_upload' and created_at < $1`, [new Date(now.getTime() - 24 * 3_600_000)]);
    for (const d of stale) {
      await this.storage.delete(d.storage_key).catch(() => undefined);
      await this.db.query(`update documents set status = 'deleted', deleted_at = now() where id = $1 and status = 'pending_upload'`, [d.id]);
    }
    return { removed: stale.length };
  }

  async getOne(id: string) {
    const row = await this.db.one(`${DOCUMENT_SQL} where d.id = $1`, [id]);
    if (!row) throw notFound('DOCUMENT_NOT_FOUND', 'Document not found');
    return view(row);
  }
}

// ------------------------------------------------------------------ helpers

function view(r: any) {
  const today = todayIst();
  const expiresOn = (r.expires_on as string | null) ?? null;
  return {
    id: r.id as string, employeeId: r.employee_id as string, employeeName: r.employee_name as string, empCode: r.emp_code as string,
    category: { code: r.category_code as string, name: r.category_name as string }, title: r.title as string,
    fileName: r.file_name as string, contentType: r.content_type as string, sizeBytes: r.size_bytes as number, status: r.status as string,
    visibility: r.visibility as string, expiresOn,
    expiry: expiresOn === null ? null : expiresOn < today ? 'expired' : expiresOn <= addDays(today, EXPIRY_WARNING_DAYS) ? 'expiring_soon' : 'valid',
    uploadedBy: { id: r.uploaded_by as string, name: r.uploaded_by_name as string }, createdAt: r.created_at as Date,
  };
}

/** A safe display/download name: no folders, control characters or characters Windows and browsers dislike. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  if (!cleaned) return 'document';
  if (cleaned.length <= 150) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  return dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(0, 150 - (cleaned.length - dot)) + cleaned.slice(dot) : cleaned.slice(0, 150);
}
