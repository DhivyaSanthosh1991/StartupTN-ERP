import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { StorageService, contentDisposition } from '../src/documents/storage.service';
import { testConfig } from './helpers';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(async (_client: unknown, command: any, options: any) =>
    `https://${command.input.Bucket}.s3.ap-south-1.amazonaws.com/${command.input.Key}?signed&ttl=${options.expiresIn}`),
}));

describe('S3 storage driver', () => {
  const send = jest.fn();
  const storage = new StorageService({ ...testConfig, storageDriver: 's3', s3Bucket: 'erp-documents' });
  (storage as any).s3 = { send };

  beforeEach(() => {
    send.mockReset();
    (getSignedUrl as jest.Mock).mockClear();
  });

  it('hands the browser a short-lived link that pins the file type and size', async () => {
    const target = await storage.uploadTarget('employees/e1/d1', 'application/pdf', 1234, '/ignored');
    expect(target).toEqual({
      method: 'PUT', url: 'https://erp-documents.s3.ap-south-1.amazonaws.com/employees/e1/d1?signed&ttl=300',
      headers: { 'Content-Type': 'application/pdf' }, expiresInSeconds: 300,
    });
    const [, command, options] = (getSignedUrl as jest.Mock).mock.calls[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toEqual({ Bucket: 'erp-documents', Key: 'employees/e1/d1', ContentType: 'application/pdf', ContentLength: 1234 });
    expect([...options.signableHeaders].sort()).toEqual(['content-length', 'content-type']);
  });

  it('downloads under the original name, as an attachment, for one minute', async () => {
    const url = await storage.downloadUrl('employees/e1/d1', 'Pay slip – Oct.pdf', 'application/pdf', '/ignored');
    expect(url).toContain('ttl=60');
    const [, command] = (getSignedUrl as jest.Mock).mock.calls[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toMatchObject({ Bucket: 'erp-documents', Key: 'employees/e1/d1', ResponseContentType: 'application/pdf' });
    expect(command.input.ResponseContentDisposition).toBe(contentDisposition('Pay slip – Oct.pdf'));
    expect(command.input.ResponseContentDisposition).toMatch(/^attachment; filename="Pay slip _ Oct\.pdf"; filename\*=UTF-8''Pay%20slip%20%E2%80%93%20Oct\.pdf$/);
  });

  it('reads an object\'s size, and treats "not found" as absent but other failures as errors', async () => {
    send.mockResolvedValueOnce({ ContentLength: 321 });
    expect(await storage.head('k')).toEqual({ size: 321 });
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[0][0].input).toEqual({ Bucket: 'erp-documents', Key: 'k' });

    send.mockRejectedValueOnce(Object.assign(new Error('nope'), { name: 'NotFound' }));
    expect(await storage.head('k')).toBeNull();
    send.mockRejectedValueOnce(Object.assign(new Error('nope'), { $metadata: { httpStatusCode: 404 } }));
    expect(await storage.head('k')).toBeNull();
    send.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }));
    await expect(storage.head('k')).rejects.toThrow('denied');
  });

  it('deletes by key', async () => {
    send.mockResolvedValueOnce({});
    await storage.delete('employees/e1/d1');
    expect(send.mock.calls[0][0]).toBeInstanceOf(DeleteObjectCommand);
    expect(send.mock.calls[0][0].input).toEqual({ Bucket: 'erp-documents', Key: 'employees/e1/d1' });
  });
});

describe('download file names', () => {
  it('keeps a plain-ASCII fallback and the exact UTF-8 name', () => {
    expect(contentDisposition('report.pdf')).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
    expect(contentDisposition('வருகை.pdf')).toContain(`filename="_____.pdf"`);
    expect(contentDisposition('a"b.pdf')).toContain('filename="a_b.pdf"');
    expect(contentDisposition("it's (1).pdf")).toContain("filename*=UTF-8''it%27s%20%281%29.pdf");
  });
});
