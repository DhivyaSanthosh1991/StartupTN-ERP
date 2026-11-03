import { createReadStream, createWriteStream, promises as fs, ReadStream } from 'fs';
import { dirname, resolve, sep } from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config/config';

export const UPLOAD_URL_TTL_SECONDS = 300;
export const DOWNLOAD_URL_TTL_SECONDS = 60;

export interface UploadTarget {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresInSeconds: number;
}

export class UploadTooLargeError extends Error {}

/**
 * Where uploaded files live. In AWS this is a private S3 bucket: the browser sends the file straight
 * to S3 and later fetches it through a short-lived signed link, so documents never pass through (or
 * sit on) the application servers. For development the same flow runs against a local folder.
 */
@Injectable()
export class StorageService {
  readonly driver: 'local' | 's3';
  private readonly root: string;
  private s3?: S3Client;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    this.driver = config.storageDriver;
    this.root = resolve(config.storageDir);
  }

  private client(): S3Client {
    return (this.s3 ??= new S3Client({ region: this.config.awsRegion }));
  }

  /** Where and how the browser should send the file. `localUrl` is used by the local driver only. */
  async uploadTarget(key: string, contentType: string, size: number, localUrl: string): Promise<UploadTarget> {
    const headers = { 'Content-Type': contentType };
    if (this.driver === 'local') return { method: 'PUT', url: localUrl, headers, expiresInSeconds: UPLOAD_URL_TTL_SECONDS };
    const url = await getSignedUrl(
      this.client(),
      new PutObjectCommand({ Bucket: this.config.s3Bucket, Key: key, ContentType: contentType, ContentLength: size }),
      { expiresIn: UPLOAD_URL_TTL_SECONDS, signableHeaders: new Set(['content-type', 'content-length']) });
    return { method: 'PUT', url, headers, expiresInSeconds: UPLOAD_URL_TTL_SECONDS };
  }

  /** A link that downloads the file under its proper name. `localUrl` is used by the local driver only. */
  async downloadUrl(key: string, fileName: string, contentType: string, localUrl: string): Promise<string> {
    if (this.driver === 'local') return localUrl;
    return getSignedUrl(
      this.client(),
      new GetObjectCommand({
        Bucket: this.config.s3Bucket, Key: key, ResponseContentType: contentType, ResponseContentDisposition: contentDisposition(fileName),
      }),
      { expiresIn: DOWNLOAD_URL_TTL_SECONDS });
  }

  /** The stored object's size, or null if there is nothing there. */
  async head(key: string): Promise<{ size: number } | null> {
    if (this.driver === 'local') {
      try {
        return { size: (await fs.stat(this.localPath(key))).size };
      } catch (err: any) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    }
    try {
      const out = await this.client().send(new HeadObjectCommand({ Bucket: this.config.s3Bucket, Key: key }));
      return { size: out.ContentLength ?? 0 };
    } catch (err: any) {
      if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  /** Stores a small object that the server itself produced (a selfie), in one piece. */
  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    if (this.driver === 'local') {
      const target = this.localPath(key);
      await fs.mkdir(dirname(target), { recursive: true });
      await fs.writeFile(target, body);
      return;
    }
    await this.client().send(new PutObjectCommand({
      Bucket: this.config.s3Bucket, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: 'AES256',
    }));
  }

  /** Reads a small stored object back into memory; null if it is not there. */
  async getObject(key: string): Promise<Buffer | null> {
    if (this.driver === 'local') {
      try {
        return await fs.readFile(this.localPath(key));
      } catch (err: any) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    }
    try {
      const out = await this.client().send(new GetObjectCommand({ Bucket: this.config.s3Bucket, Key: key }));
      return Buffer.from(await out.Body!.transformToByteArray());
    } catch (err: any) {
      if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    if (this.driver === 'local') {
      await fs.rm(this.localPath(key), { force: true });
      return;
    }
    await this.client().send(new DeleteObjectCommand({ Bucket: this.config.s3Bucket, Key: key }));
  }

  // ---- local driver only ----------------------------------------------------

  /** Writes an incoming stream to disk, refusing more than `maxBytes`. Returns the bytes written. */
  async saveLocal(key: string, input: Readable, maxBytes: number): Promise<number> {
    const target = this.localPath(key);
    const temp = `${target}.part`;
    await fs.mkdir(dirname(target), { recursive: true });
    let total = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        total += chunk.length;
        if (total > maxBytes) cb(new UploadTooLargeError());
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(input, counter, createWriteStream(temp));
      await fs.rename(temp, target);
      return total;
    } catch (err) {
      await fs.rm(temp, { force: true });
      throw err;
    }
  }

  openLocal(key: string): ReadStream {
    return createReadStream(this.localPath(key));
  }

  /** Keys are generated by the server, but a path is never trusted to stay inside the storage folder. */
  private localPath(key: string): string {
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return full;
  }
}

/** Content-Disposition for a download: plain ASCII fallback plus the exact UTF-8 name. */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
