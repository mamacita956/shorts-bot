import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { HttpError, send, sendJson } from './http';

export const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];

export interface GoogleEndpoints {
  auth: string;
  token: string;
  api: string;
  upload: string;
}

export const GOOGLE: GoogleEndpoints = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  api: 'https://www.googleapis.com/youtube/v3',
  upload: 'https://www.googleapis.com/upload/youtube/v3',
};

/** YouTube rejects < and > in titles and descriptions; descriptions are capped in bytes. */
export function cleanText(s: string, maxBytes: number): string {
  let out = s.replace(/[<>]/g, '');
  while (Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(0, -1);
  return out;
}

/** YouTube's 500-character tag budget counts the commas between tags and quotes around tags with spaces. */
export function fitTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  let used = 0;
  for (const raw of tags) {
    const t = raw.replace(/^#+/, '').replace(/[<>,"]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const key = t.toLocaleLowerCase('tr');
    if (!t || seen.has(key)) continue;
    const cost = t.length + (t.includes(' ') ? 2 : 0) + (out.length ? 1 : 0);
    if (used + cost > 500) break;
    seen.add(key);
    out.push(t);
    used += cost;
  }
  return out;
}

const b64url = (b: Buffer) => b.toString('base64url');

interface TokenFile {
  clientId: string;
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
  channelId?: string;
  channelTitle?: string;
  connectedAt: string;
}

export interface VideoMeta {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  language: string;
  /** ISO time; the video stays private until YouTube publishes it then. */
  publishAt?: string;
  madeForKids: boolean;
  syntheticMedia: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class YouTube {
  private pending?: { state: string; verifier: string; redirectUri: string; clientId: string; at: number };

  constructor(
    private readonly tokenFile: string,
    private readonly creds: () => { clientId: string; clientSecret: string },
    private readonly ep: GoogleEndpoints = GOOGLE,
    private readonly retryDelayMs = 2000,
  ) {}

  private read(): TokenFile | null {
    try {
      return JSON.parse(readFileSync(this.tokenFile, 'utf8')) as TokenFile;
    } catch {
      return null;
    }
  }

  private write(t: TokenFile): void {
    mkdirSync(dirname(this.tokenFile), { recursive: true });
    const tmp = `${this.tokenFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(t, null, 2), { mode: 0o600 });
    renameSync(tmp, this.tokenFile);
  }

  status(): { connected: boolean; channelTitle?: string; channelId?: string } {
    const t = this.read();
    if (!t || t.clientId !== this.creds().clientId) return { connected: false };
    return { connected: true, channelTitle: t.channelTitle, channelId: t.channelId };
  }

  disconnect(): void {
    rmSync(this.tokenFile, { force: true });
  }

  /** Google's consent page; it redirects back to `redirectUri` (this app's local server). */
  authUrl(redirectUri: string): string {
    const { clientId } = this.creds();
    if (!clientId) throw new Error('Önce Ayarlar → YouTube bölümüne Google Client ID gir');
    const verifier = b64url(randomBytes(48));
    const state = b64url(randomBytes(18));
    this.pending = { state, verifier, redirectUri, clientId, at: Date.now() };
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      state,
    });
    return `${this.ep.auth}?${q}`;
  }

  isAuthCallback(q: URLSearchParams): boolean {
    return Boolean(this.pending && q.get('state') === this.pending.state);
  }

  private tokenRequest(fields: Record<string, string>) {
    const { clientSecret } = this.creds();
    const body = new URLSearchParams({ ...fields, ...(clientSecret ? { client_secret: clientSecret } : {}) });
    return sendJson<{ access_token: string; expires_in: number; refresh_token?: string }>('Google', this.ep.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  }

  async finishAuth(q: URLSearchParams): Promise<string> {
    const p = this.pending;
    if (!p || q.get('state') !== p.state) throw new Error('Bu bağlantı isteği geçersiz; panelden tekrar "YouTube’a bağlan"a bas');
    this.pending = undefined;
    if (q.get('error')) throw new Error(`Google izni verilmedi (${q.get('error')})`);
    if (Date.now() - p.at > 15 * 60_000) throw new Error('Bağlantı isteğinin süresi doldu; tekrar dene');
    const code = q.get('code');
    if (!code) throw new Error('Google yetki kodu göndermedi');
    const tok = await this.tokenRequest({
      client_id: p.clientId,
      code,
      code_verifier: p.verifier,
      grant_type: 'authorization_code',
      redirect_uri: p.redirectUri,
    });
    if (!tok.refresh_token) {
      throw new Error('Google kalıcı erişim anahtarı vermedi. myaccount.google.com/permissions sayfasından uygulamanın erişimini kaldırıp tekrar bağlan.');
    }
    const ch = await sendJson<{ items?: { id: string; snippet?: { title?: string } }[] }>('YouTube', `${this.ep.api}/channels?part=snippet&mine=true`, {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    const item = ch.items?.[0];
    if (!item) throw new Error('Bu Google hesabında YouTube kanalı yok. Kanalın bağlı olduğu hesapla giriş yap.');
    this.write({
      clientId: p.clientId,
      refreshToken: tok.refresh_token,
      accessToken: tok.access_token,
      expiresAt: Date.now() + tok.expires_in * 1000,
      channelId: item.id,
      channelTitle: item.snippet?.title ?? item.id,
      connectedAt: new Date().toISOString(),
    });
    return item.snippet?.title ?? item.id;
  }

  private async accessToken(force = false): Promise<string> {
    const t = this.read();
    if (!t || t.clientId !== this.creds().clientId) throw new Error('YouTube bağlı değil (Ayarlar → YouTube’a bağlan)');
    if (!force && t.accessToken && (t.expiresAt ?? 0) > Date.now() + 60_000) return t.accessToken;
    try {
      const tok = await this.tokenRequest({ client_id: t.clientId, refresh_token: t.refreshToken, grant_type: 'refresh_token' });
      this.write({ ...t, accessToken: tok.access_token, expiresAt: Date.now() + tok.expires_in * 1000 });
      return tok.access_token;
    } catch (e) {
      if (e instanceof HttpError && (e.status === 400 || e.status === 401) && e.body.includes('invalid_grant')) {
        this.disconnect();
        throw new Error('YouTube bağlantısının süresi doldu ya da izin geri alındı; Ayarlar’dan yeniden bağlan');
      }
      throw e;
    }
  }

  /** Resumable upload (survives dropped connections); returns the new video's id. */
  async upload(file: string, meta: VideoMeta): Promise<string> {
    const data = await readFile(file);
    const size = data.length;
    const resource = {
      snippet: {
        title: cleanText(meta.title, 100) || 'Shorts',
        description: cleanText(meta.description, 5000),
        tags: fitTags(meta.tags),
        categoryId: meta.categoryId,
        defaultLanguage: meta.language,
        defaultAudioLanguage: meta.language,
      },
      status: {
        privacyStatus: meta.publishAt ? 'private' : 'public',
        ...(meta.publishAt ? { publishAt: meta.publishAt } : {}),
        selfDeclaredMadeForKids: meta.madeForKids,
        containsSyntheticMedia: meta.syntheticMedia,
      },
    };

    const start = async (token: string) =>
      send('YouTube', `${this.ep.upload}/videos?uploadType=resumable&part=snippet,status`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Length': String(size),
          'X-Upload-Content-Type': 'video/mp4',
        },
        body: JSON.stringify(resource),
      });

    let token = await this.accessToken();
    let res: Response;
    try {
      res = await start(token);
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 401)) throw this.explain(e);
      token = await this.accessToken(true);
      res = await start(token).catch((x) => {
        throw this.explain(x);
      });
    }
    const location = res.headers.get('location');
    if (!location) throw new Error('YouTube yükleme adresi vermedi');

    let offset = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const put = await fetch(location, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'video/mp4',
            ...(offset ? { 'Content-Range': `bytes ${offset}-${size - 1}/${size}` } : {}),
          },
          body: data.subarray(offset),
          signal: AbortSignal.timeout(30 * 60_000),
        });
        if (put.ok) return ((await put.json()) as { id: string }).id;
        if (put.status < 500 && put.status !== 308) {
          const body = await put.text();
          throw this.explain(new HttpError(`YouTube hatası ${put.status}: ${body.slice(0, 300)}`, put.status, body, put.headers));
        }
      } catch (e) {
        if (!(e instanceof Error) || !(e.name === 'TimeoutError' || e instanceof TypeError)) throw e;
      }
      await sleep(this.retryDelayMs * 2 ** attempt);
      // Ask how much arrived, then continue from there.
      const st = await fetch(location, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Range': `bytes */${size}` },
        body: new Uint8Array(0),
      }).catch(() => null);
      if (!st) continue;
      if (st.ok) return ((await st.json()) as { id: string }).id;
      if (st.status === 308) {
        const m = /bytes=0-(\d+)/.exec(st.headers.get('range') ?? '');
        offset = m ? Number(m[1]) + 1 : 0;
      } else if (st.status === 404 || st.status === 410) {
        throw new Error('YouTube yükleme oturumu sona erdi; yükleme baştan denenecek');
      }
    }
    throw new Error('YouTube yüklemesi birkaç denemede tamamlanamadı; daha sonra tekrar denenecek');
  }

  private explain(e: unknown): Error {
    if (!(e instanceof HttpError)) return e as Error;
    if (e.status === 403 && /quotaExceeded|uploadLimitExceeded/.test(e.body)) return new Error('YouTube günlük yükleme sınırına gelindi; yarın tekrar denenecek');
    if (e.status === 403 && /youtubeSignupRequired/.test(e.body)) return new Error('Bu Google hesabının YouTube kanalı yok');
    if (e.status === 403 && /forbidden|insufficientPermissions/.test(e.body)) return new Error(`YouTube izin vermedi: ${e.message}`);
    return e;
  }

  private async authed<T>(url: string, init: RequestInit = {}): Promise<T> {
    const call = (token: string) =>
      sendJson<T>('YouTube', url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } });
    try {
      return await call(await this.accessToken());
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) return call(await this.accessToken(true));
      throw e;
    }
  }

  /** "processing", "succeeded", "failed" or "terminated"; a Short's custom thumbnail must wait for "succeeded". */
  async processingStatus(videoId: string): Promise<string> {
    const r = await this.authed<{ items?: { processingDetails?: { processingStatus?: string } }[] }>(
      `${this.ep.api}/videos?part=processingDetails&id=${encodeURIComponent(videoId)}`,
    );
    const item = r.items?.[0];
    if (!item) throw new Error('Video YouTube’da bulunamadı (silinmiş olabilir)');
    return item.processingDetails?.processingStatus ?? 'processing';
  }

  async setThumbnail(videoId: string, file: string): Promise<void> {
    const data = await readFile(file);
    try {
      await this.authed(`${this.ep.upload}/thumbnails/set?videoId=${encodeURIComponent(videoId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg' },
        body: data,
      });
    } catch (e) {
      if (e instanceof HttpError && e.status === 403) {
        throw new ThumbnailForbiddenError(
          'YouTube özel kapak yüklemeye izin vermedi. Kanalının telefonla doğrulanmış olması gerekiyor: youtube.com/verify',
        );
      }
      throw this.explain(e);
    }
  }

  /** Public counts and state of up to 50 videos per call (1 quota unit). */
  async videoStats(ids: string[]): Promise<Map<string, VideoStats>> {
    const out = new Map<string, VideoStats>();
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const r = await this.authed<{
        items?: {
          id: string;
          statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
          status?: { uploadStatus?: string; privacyStatus?: string; rejectionReason?: string; failureReason?: string };
        }[];
      }>(`${this.ep.api}/videos?part=statistics,status&id=${chunk.map(encodeURIComponent).join(',')}`);
      for (const it of r.items ?? []) {
        out.set(it.id, {
          views: Number(it.statistics?.viewCount ?? 0),
          likes: Number(it.statistics?.likeCount ?? 0),
          comments: Number(it.statistics?.commentCount ?? 0),
          uploadStatus: it.status?.uploadStatus ?? '',
          privacy: it.status?.privacyStatus ?? '',
          problem: it.status?.rejectionReason ?? it.status?.failureReason ?? '',
        });
      }
    }
    return out;
  }
}

export interface VideoStats {
  views: number;
  likes: number;
  comments: number;
  uploadStatus: string;
  privacy: string;
  /** YouTube's rejection or failure reason, if any. */
  problem: string;
}

/** The channel may not set custom thumbnails (usually: not phone-verified); retrying will not help. */
export class ThumbnailForbiddenError extends Error {}
