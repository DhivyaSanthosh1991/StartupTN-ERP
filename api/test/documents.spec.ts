import { promises as fs } from 'fs';
import { addDays, todayIst } from '../src/common/dates';
import { DocumentsService, MAX_DOCUMENT_BYTES, sanitizeFileName } from '../src/documents/documents.service';
import { StorageService } from '../src/documents/storage.service';
import { TestEnv, createTestEnv, testConfig } from './helpers';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

describe('employee documents', () => {
  let env: TestEnv;
  let storage: StorageService;

  type Opts = { bytes?: Buffer; fileName?: string; contentType?: string; categoryCode?: string; title?: string } & Record<string, unknown>;

  /** The three steps a browser performs: announce, send the bytes, confirm. */
  const upload = async (agent: any, opts: Opts = {}) => {
    const { bytes = PDF, fileName = 'aadhaar.pdf', contentType = 'application/pdf', categoryCode = 'id_proof', title = 'Aadhaar card', ...extra } = opts;
    const created = await agent.post('/api/documents').send({ categoryCode, title, fileName, contentType, sizeBytes: bytes.length, ...extra });
    if (created.status !== 201) return created;
    const target = created.body.upload;
    const sent = await agent[target.method.toLowerCase()](target.url).set(target.headers).send(bytes);
    expect(sent.status).toBe(204);
    return agent.post(`/api/documents/${created.body.document.id}/complete`);
  };

  const listOf = async (agent: any, employeeId: string) => (await agent.get(`/api/employees/${employeeId}/documents`)).body;

  beforeAll(async () => {
    env = await createTestEnv();
    storage = env.app.get(StorageService);
  });
  beforeEach(() => env.reset());
  afterAll(async () => {
    await env.close();
    await fs.rm(testConfig.storageDir, { recursive: true, force: true });
  });

  describe('uploading and downloading', () => {
    it('lists the categories HR set up', async () => {
      const res = await (await env.as('priya')).get('/api/documents/categories');
      expect(res.body.map((c: any) => c.code)).toEqual(['id_proof', 'address_proof', 'education', 'experience', 'offer_letter', 'contract', 'certificate', 'other']);
      expect(res.body.filter((c: any) => c.expiryTracked).map((c: any) => c.code)).toEqual(['contract', 'certificate']);
    });

    it('takes a file in three steps and serves it back with its bytes intact', async () => {
      const priya = await env.as('priya');
      const created = await priya.post('/api/documents').send({
        categoryCode: 'id_proof', title: 'Aadhaar card', fileName: 'aadhaar.pdf', contentType: 'application/pdf', sizeBytes: PDF.length,
      });
      expect(created.status).toBe(201);
      expect(created.body.document).toMatchObject({ status: 'pending_upload', employeeName: 'Priya Raman', visibility: 'employee_and_hr' });
      expect(created.body.upload).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'application/pdf' } });
      const id = created.body.document.id;

      // Until the upload is confirmed, it is neither listed nor downloadable.
      expect(await listOf(priya, env.ids.priya)).toEqual([]);
      expect((await priya.get(`/api/documents/${id}/download-url`)).status).toBe(404);

      expect((await priya.put(created.body.upload.url).set('Content-Type', 'application/pdf').send(PDF)).status).toBe(204);
      const done = await priya.post(`/api/documents/${id}/complete`);
      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({ status: 'available', sizeBytes: PDF.length, category: { code: 'id_proof', name: 'ID proof' }, uploadedBy: { name: 'Priya Raman' } });
      expect((await priya.post(`/api/documents/${id}/complete`)).status).toBe(200); // confirming twice is harmless

      expect((await listOf(priya, env.ids.priya)).map((d: any) => d.title)).toEqual(['Aadhaar card']);

      const link = await priya.get(`/api/documents/${id}/download-url`);
      expect(link.body).toMatchObject({ fileName: 'aadhaar.pdf', expiresInSeconds: 60 });
      const file = await priya.get(link.body.url).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(file.status).toBe(200);
      expect(Buffer.compare(file.body, PDF)).toBe(0);
      expect(file.headers['content-type']).toContain('application/pdf');
      expect(file.headers['content-disposition']).toContain('attachment; filename="aadhaar.pdf"');
      expect(file.headers['x-content-type-options']).toBe('nosniff');
    });

    it('audits every upload and every download', async () => {
      const priya = await env.as('priya');
      const doc = (await upload(priya)).body;
      await priya.get(`/api/documents/${doc.id}/download-url`);
      await (await env.as('hema')).get(`/api/documents/${doc.id}/download-url`);
      const rows = await env.db.rows(`select action, actor_id from audit_log where entity_id = $1 order by id`, [doc.id]);
      expect(rows).toEqual([
        { action: 'document.create', actor_id: env.ids.priya }, { action: 'document.upload', actor_id: env.ids.priya },
        { action: 'document.download', actor_id: env.ids.priya }, { action: 'document.download', actor_id: env.ids.hr },
      ]);
    });

    it('will not confirm an upload whose file never arrived', async () => {
      const priya = await env.as('priya');
      const created = await priya.post('/api/documents').send({ categoryCode: 'other', title: 'X', fileName: 'x.pdf', contentType: 'application/pdf', sizeBytes: 100 });
      const res = await priya.post(`/api/documents/${created.body.document.id}/complete`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('UPLOAD_MISSING');
    });

    it('refuses bytes that do not match what was announced', async () => {
      const priya = await env.as('priya');
      const created = await priya.post('/api/documents').send({ categoryCode: 'other', title: 'X', fileName: 'x.pdf', contentType: 'application/pdf', sizeBytes: PDF.length });
      const url = created.body.upload.url;
      const wrongSize = await priya.put(url).set('Content-Type', 'application/pdf').send(Buffer.concat([PDF, Buffer.from('extra')]));
      expect(wrongSize.body.code).toBe('SIZE_MISMATCH');
      const wrongType = await priya.put(url).set('Content-Type', 'image/png').send(PDF);
      expect(wrongType.body.code).toBe('CONTENT_TYPE_MISMATCH');
      expect(await storage.head(`employees/${env.ids.priya}/${created.body.document.id}`)).toBeNull();
    });

    it('only the person who started an upload can send or confirm it', async () => {
      const priya = await env.as('priya');
      const created = await priya.post('/api/documents').send({ categoryCode: 'other', title: 'X', fileName: 'x.pdf', contentType: 'application/pdf', sizeBytes: PDF.length });
      const ravi = await env.as('ravi');
      expect((await ravi.put(created.body.upload.url).set('Content-Type', 'application/pdf').send(PDF)).status).toBe(404);
      expect((await ravi.post(`/api/documents/${created.body.document.id}/complete`)).status).toBe(404);
    });

    it('needs a signed-in user', async () => {
      expect((await env.anon().post('/api/documents').send({})).status).toBe(401);
      expect((await env.anon().get('/api/documents/categories')).status).toBe(401);
    });
  });

  describe('what may be stored', () => {
    const create = (agent: any, over: Record<string, unknown>) =>
      agent.post('/api/documents').send({ categoryCode: 'other', title: 'X', fileName: 'x.pdf', contentType: 'application/pdf', sizeBytes: 100, ...over });

    it('accepts PDFs, images and office files, and nothing a browser could run', async () => {
      const priya = await env.as('priya');
      for (const [fileName, contentType] of [
        ['a.pdf', 'application/pdf'], ['a.JPG', 'image/jpeg'], ['a.png', 'image/png'], ['a.webp', 'image/webp'],
        ['a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ['a.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ]) expect((await create(priya, { fileName, contentType })).status).toBe(201);
      for (const [fileName, contentType] of [['a.html', 'text/html'], ['a.svg', 'image/svg+xml'], ['a.js', 'application/javascript'], ['a.exe', 'application/octet-stream']]) {
        expect((await create(priya, { fileName, contentType })).body.code).toBe('FILE_TYPE_NOT_ALLOWED');
      }
    });

    it('checks the extension against the type', async () => {
      const res = await create(await env.as('priya'), { fileName: 'invoice.exe', contentType: 'application/pdf' });
      expect(res.body.code).toBe('FILE_TYPE_MISMATCH');
      expect((await create(await env.as('priya'), { fileName: 'noextension', contentType: 'application/pdf' })).body.code).toBe('FILE_TYPE_MISMATCH');
    });

    it('limits size, rejects empty files and unknown categories', async () => {
      const priya = await env.as('priya');
      expect((await create(priya, { sizeBytes: MAX_DOCUMENT_BYTES })).status).toBe(201);
      expect((await create(priya, { sizeBytes: MAX_DOCUMENT_BYTES + 1 })).body.code).toBe('FILE_TOO_LARGE');
      expect((await create(priya, { sizeBytes: 0 })).body.code).toBe('EMPTY_FILE');
      expect((await create(priya, { categoryCode: 'nonsense' })).body.code).toBe('CATEGORY_INVALID');
      expect((await create(priya, { sizeBytes: 1.5 })).body.code).toBe('VALIDATION');
      expect((await create(priya, { expiresOn: '2026-02-30' })).body.code).toBe('VALIDATION');
    });

    it('stores files under a server-made key, whatever the file is called', async () => {
      const priya = await env.as('priya');
      const res = await create(priya, { fileName: '../../etc/passwd.pdf' });
      expect(res.body.document.fileName).toBe('passwd.pdf');
      const row = await env.db.one('select storage_key from documents where id = $1', [res.body.document.id]);
      expect(row!.storage_key).toBe(`employees/${env.ids.priya}/${res.body.document.id}`);
    });

    it('cleans up awkward file names', () => {
      expect(sanitizeFileName('C:\\Users\\me\\Pay slip.pdf')).toBe('Pay slip.pdf');
      expect(sanitizeFileName('../../x.pdf')).toBe('x.pdf');
      expect(sanitizeFileName('..hidden.pdf')).toBe('hidden.pdf');
      expect(sanitizeFileName('a\u0000b\u001f<c>:"|?*.pdf')).toBe('abc.pdf');
      expect(sanitizeFileName('   ')).toBe('document');
      expect(sanitizeFileName('///')).toBe('document');
      const long = sanitizeFileName(`${'a'.repeat(300)}.pdf`);
      expect(long).toHaveLength(150);
      expect(long.endsWith('.pdf')).toBe(true);
    });

    it('never lets a storage key leave the storage folder', async () => {
      await expect(storage.head('../../etc/passwd')).rejects.toThrow('Invalid storage key');
      await expect(storage.delete('../outside')).rejects.toThrow('Invalid storage key');
    });
  });

  describe('who can see what', () => {
    it('employees see their own records; managers and colleagues do not see personal documents', async () => {
      const priya = await env.as('priya');
      const doc = (await upload(priya)).body;
      for (const who of ['priya', 'hema']) expect((await (await env.as(who)).get(`/api/employees/${env.ids.priya}/documents`)).status).toBe(200);
      for (const who of ['mani', 'hari', 'ravi', 'meena']) {
        const other = await env.as(who);
        expect((await other.get(`/api/employees/${env.ids.priya}/documents`)).status).toBe(403);
        expect((await other.get(`/api/documents/${doc.id}/download-url`)).status).toBe(404);
        expect((await other.get(`/api/documents/${doc.id}/file`)).status).toBe(404);
      }
      expect((await (await env.as('hema')).get(`/api/documents/${doc.id}/download-url`)).status).toBe(200);
    });

    it('HR can add a document to anyone\'s record, and keep it from the employee', async () => {
      const hr = await env.as('hema');
      const open = (await upload(hr, { employeeId: env.ids.priya, categoryCode: 'offer_letter', title: 'Offer letter', fileName: 'offer.pdf' })).body;
      const secret = (await upload(hr, { employeeId: env.ids.priya, title: 'Disciplinary note', fileName: 'note.pdf', visibility: 'hr_only' })).body;
      expect(secret.visibility).toBe('hr_only');

      const priya = await env.as('priya');
      expect((await listOf(priya, env.ids.priya)).map((d: any) => d.title)).toEqual(['Offer letter']);
      expect((await priya.get(`/api/documents/${open.id}/download-url`)).status).toBe(200);
      expect((await priya.get(`/api/documents/${secret.id}/download-url`)).status).toBe(404);
      expect((await listOf(hr, env.ids.priya)).map((d: any) => d.title).sort()).toEqual(['Disciplinary note', 'Offer letter']);
    });

    it('employees cannot add to someone else\'s record or make a document HR-only', async () => {
      const priya = await env.as('priya');
      const other = await upload(priya, { employeeId: env.ids.ravi });
      expect(other.status).toBe(403);
      const own = (await upload(priya, { visibility: 'hr_only' })).body;
      expect(own.visibility).toBe('employee_and_hr');
      expect((await upload(priya, { employeeId: '11111111-1111-4111-8111-111111111111' })).status).toBe(403);
      expect((await upload(await env.as('hema'), { employeeId: '11111111-1111-4111-8111-111111111111' })).status).toBe(404);
    });
  });

  describe('changing and removing', () => {
    it('the owner can retitle and set an expiry on what they uploaded, but not who sees it', async () => {
      const priya = await env.as('priya');
      const doc = (await upload(priya)).body;
      const next = addDays(todayIst(), 200);
      const ok = await priya.patch(`/api/documents/${doc.id}`).send({ title: 'Aadhaar (front and back)', expiresOn: next });
      expect(ok.body).toMatchObject({ title: 'Aadhaar (front and back)', expiresOn: next, expiry: 'valid' });
      expect((await priya.patch(`/api/documents/${doc.id}`).send({ visibility: 'hr_only' })).status).toBe(403);
      expect((await (await env.as('ravi')).patch(`/api/documents/${doc.id}`).send({ title: 'x' })).status).toBe(404);
      expect((await (await env.as('hema')).patch(`/api/documents/${doc.id}`).send({ visibility: 'hr_only' })).body.visibility).toBe('hr_only');
      expect(await listOf(priya, env.ids.priya)).toEqual([]);
    });

    it('removing a document deletes the file and leaves a record that it existed', async () => {
      const priya = await env.as('priya');
      const doc = (await upload(priya)).body;
      const key = `employees/${env.ids.priya}/${doc.id}`;
      expect(await storage.head(key)).toEqual({ size: PDF.length });

      expect((await priya.delete(`/api/documents/${doc.id}`)).status).toBe(204);
      expect(await storage.head(key)).toBeNull();
      expect(await listOf(priya, env.ids.priya)).toEqual([]);
      expect((await priya.get(`/api/documents/${doc.id}/download-url`)).status).toBe(404);
      expect(await env.db.one('select status, deleted_at is not null as gone from documents where id = $1', [doc.id])).toMatchObject({ status: 'deleted', gone: true });
      expect((await priya.delete(`/api/documents/${doc.id}`)).status).toBe(404);
      expect(await env.db.rows(`select 1 from audit_log where action = 'document.delete' and entity_id = $1`, [doc.id])).toHaveLength(1);
    });

    it('employees cannot remove what HR added; HR can remove anything', async () => {
      const hr = await env.as('hema');
      const hrDoc = (await upload(hr, { employeeId: env.ids.priya, title: 'Contract', categoryCode: 'contract', fileName: 'c.pdf' })).body;
      const priya = await env.as('priya');
      expect((await priya.delete(`/api/documents/${hrDoc.id}`)).status).toBe(404);
      const own = (await upload(priya)).body;
      expect((await (await env.as('ravi')).delete(`/api/documents/${own.id}`)).status).toBe(404);
      expect((await hr.delete(`/api/documents/${own.id}`)).status).toBe(204);
      expect((await hr.delete(`/api/documents/${hrDoc.id}`)).status).toBe(204);
    });
  });

  describe('expiry tracking', () => {
    it('marks documents as valid, expiring soon or expired', async () => {
      const priya = await env.as('priya');
      await upload(priya, { categoryCode: 'certificate', title: 'Far off', fileName: 'a.pdf', expiresOn: addDays(todayIst(), 120) });
      await upload(priya, { categoryCode: 'certificate', title: 'Soon', fileName: 'b.pdf', expiresOn: addDays(todayIst(), 10) });
      await upload(priya, { categoryCode: 'certificate', title: 'Lapsed', fileName: 'c.pdf', expiresOn: addDays(todayIst(), -3) });
      await upload(priya, { title: 'No expiry', fileName: 'd.pdf' });

      const states = Object.fromEntries((await listOf(priya, env.ids.priya)).map((d: any) => [d.title, d.expiry]));
      expect(states).toEqual({ 'Far off': 'valid', Soon: 'expiring_soon', Lapsed: 'expired', 'No expiry': null });

      const mine = (await priya.get('/api/documents/expiring')).body;
      expect(mine.map((d: any) => d.title)).toEqual(['Lapsed', 'Soon']);
      expect((await priya.get('/api/documents/expiring').query({ days: 200 })).body).toHaveLength(3);
    });

    it('gives HR an organisation-wide view, which no one else can open', async () => {
      await upload(await env.as('priya'), { categoryCode: 'certificate', title: 'Priya cert', fileName: 'a.pdf', expiresOn: addDays(todayIst(), 5) });
      await upload(await env.as('ravi'), { categoryCode: 'certificate', title: 'Ravi cert', fileName: 'b.pdf', expiresOn: addDays(todayIst(), 2) });
      const hr = await env.as('hema');
      await upload(hr, { employeeId: env.ids.ravi, categoryCode: 'contract', title: 'Hidden contract', fileName: 'c.pdf', expiresOn: addDays(todayIst(), 1), visibility: 'hr_only' });

      const all = (await hr.get('/api/admin/documents/expiring').query({ days: 30 })).body;
      expect(all.map((d: any) => `${d.employeeName}: ${d.title}`)).toEqual(['Ravi Kumar: Hidden contract', 'Ravi Kumar: Ravi cert', 'Priya Raman: Priya cert']);
      expect((await (await env.as('ravi')).get('/api/documents/expiring')).body.map((d: any) => d.title)).toEqual(['Ravi cert']); // not the HR-only one
      expect((await (await env.as('priya')).get('/api/admin/documents/expiring')).status).toBe(403);
    });

    it('ignores people who have left', async () => {
      await upload(await env.as('priya'), { categoryCode: 'certificate', title: 'Gone', fileName: 'a.pdf', expiresOn: addDays(todayIst(), 5) });
      await env.db.query(`update employees set status = 'exited' where id = $1`, [env.ids.priya]);
      expect((await (await env.as('hema')).get('/api/admin/documents/expiring')).body).toEqual([]);
    });
  });

  describe('abandoned uploads', () => {
    it('clears uploads started but never finished after a day', async () => {
      const priya = await env.as('priya');
      const stale = (await priya.post('/api/documents').send({ categoryCode: 'other', title: 'Stale', fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: PDF.length })).body.document;
      await priya.put(`/api/documents/${stale.id}/content`).set('Content-Type', 'application/pdf').send(PDF);
      const fresh = (await priya.post('/api/documents').send({ categoryCode: 'other', title: 'Fresh', fileName: 'b.pdf', contentType: 'application/pdf', sizeBytes: PDF.length })).body.document;
      const done = (await upload(priya, { title: 'Done' })).body;
      await env.db.query(`update documents set created_at = now() - interval '2 days' where id in ($1, $2)`, [stale.id, done.id]);

      expect(await env.app.get(DocumentsService).purgeAbandoned()).toEqual({ removed: 1 });
      const statuses = Object.fromEntries((await env.db.rows('select title, status from documents')).map((r) => [r.title, r.status]));
      expect(statuses).toEqual({ Stale: 'deleted', Fresh: 'pending_upload', Done: 'available' });
      expect(await storage.head(`employees/${env.ids.priya}/${stale.id}`)).toBeNull();
      expect(fresh.status).toBe('pending_upload');
    });
  });
});
