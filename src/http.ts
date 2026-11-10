import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    readonly headers: Headers,
  ) {
    super(message);
  }
}

/** Pulls a human-readable reason out of the JSON error shapes these APIs use. */
function detailOf(body: string): string {
  try {
    const j = JSON.parse(body);
    const d =
      j?.error?.message ??
      j?.error_description ??
      (typeof j?.error === 'string' ? j.error : undefined) ??
      j?.message ??
      (Array.isArray(j?.detail) ? j.detail.map((x: { msg?: string }) => x.msg).join('; ') : j?.detail?.message ?? j?.detail) ??
      j?.code;
    if (d) return String(d);
  } catch {
    // not JSON
  }
  return body.slice(0, 300);
}

export async function send(service: string, url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 60_000, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const why = err.name === 'TimeoutError' ? 'zaman aşımı' : err.cause?.code ?? err.cause?.message ?? err.message;
    throw new Error(`${service} sunucusuna bağlanılamadı (${why})`);
  }
  if (!res.ok && res.status !== 308) {
    const body = await res.text().catch(() => '');
    throw new HttpError(`${service} hatası ${res.status}: ${detailOf(body)}`, res.status, body, res.headers);
  }
  return res;
}

export async function sendJson<T>(service: string, url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const res = await send(service, url, init);
  const text = await res.text();
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new Error(`${service} beklenmeyen bir cevap döndürdü`);
  }
}

/** Streams a URL to disk; the file only appears under `dest` once it is complete. */
export async function download(service: string, url: string, dest: string): Promise<void> {
  const res = await send(service, url, { timeoutMs: 10 * 60_000 });
  if (!res.body) throw new Error(`${service} boş dosya döndürdü`);
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as WebReadableStream), createWriteStream(tmp));
    await rename(tmp, dest);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}
