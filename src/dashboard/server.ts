import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { log } from '../log';
import type { Runtime } from '../runtime';
import { CATEGORIES, CLAUDE_MODELS, CLIP_BUCKETS, ELEVEN_MODELS, LANGUAGES, OPUS_GENRES, OPUS_MODELS } from '../settings';

export interface DashboardOptions {
  host: string;
  port: number;
  htmlPath: string;
  /** Opens a folder in the file manager; only the desktop app can. */
  openPath?: (path: string) => void;
  /** Running inside the desktop app (shows the "start with Windows" setting). */
  desktop?: boolean;
}

const TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.jpg': 'image/jpeg' };

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 65_536) throw new Error('İstek çok büyük');
    chunks.push(c as Buffer);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('Geçersiz istek');
  return body;
}

/** Serves a media file with byte ranges, which the video player needs for seeking. */
function serveFile(req: IncomingMessage, res: ServerResponse, file: string) {
  const size = statSync(file).size;
  const head = { 'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (!m || (!m[1] && !m[2])) {
    res.writeHead(200, { ...head, 'Content-Length': size });
    createReadStream(file).pipe(res);
    return;
  }
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start > end || start >= size) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }
  res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  createReadStream(file, { start, end }).pipe(res);
}

const page = (title: string, text: string, ok: boolean) => `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shorts Bot</title>
<style>body{font:16px/1.5 system-ui,"Segoe UI",sans-serif;background:#f4f3f0;color:#0b0b0b;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}
main{max-width:460px;background:#fcfcfb;border:1px solid #e2e1dc;border-radius:12px;padding:24px}h1{font-size:18px;margin:0 0 8px;color:${ok ? '#006300' : '#b42828'}}
@media (prefers-color-scheme: dark){body{background:#111110;color:#f0efec}main{background:#1a1a19;border-color:#2f2f2c}h1{color:${ok ? '#3fc43f' : '#ef7a7a'}}}</style></head>
<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export function startDashboard(rt: Runtime, opts: DashboardOptions): Promise<{ port: number; close: () => void }> {
  let port = opts.port;
  const mediaRoot = resolve(rt.paths.home, 'media');

  const post = async (path: string, body: Record<string, unknown>): Promise<unknown> => {
    const s = (k: string) => String(body[k] ?? '');
    let m: RegExpExecArray | null;
    if (path === '/api/settings') {
      await rt.saveSettings(body);
      return { ok: true };
    }
    if (path === '/api/sources') return rt.addSource(s('url'), s('note'), s('prompt'));
    if ((m = /^\/api\/sources\/([\w-]+)\/(check|delete)$/.exec(path))) {
      if (m[2] === 'check') rt.checkSource(m[1]);
      else rt.removeSource(m[1]);
      return { ok: true };
    }
    if ((m = /^\/api\/clips\/([^/]+)\/(draft|skip|unskip)$/.exec(path))) {
      const key = decodeURIComponent(m[1]);
      if (m[2] === 'draft') return rt.draftClip(key, s('instructions'));
      rt.skipClip(key, m[2] === 'skip');
      return { ok: true };
    }
    if ((m = /^\/api\/drafts\/([\w-]+)\/([a-z-]+)$/.exec(path))) {
      const [, id, action] = m;
      switch (action) {
        case 'save':
          rt.saveDraft(id, body);
          break;
        case 'rewrite':
          rt.rewriteDraft(id, body.instructions === undefined ? undefined : s('instructions'));
          break;
        case 'revoice':
          rt.revoiceDraft(id);
          break;
        case 'retry':
          rt.retryDraft(id);
          break;
        case 'approve':
          return { ok: true, slot: rt.approveDraft(id) };
        case 'unapprove':
          rt.unapproveDraft(id);
          break;
        case 'reject':
          rt.rejectDraft(id);
          break;
        case 'retry-upload':
          rt.retryUpload(id);
          break;
        case 'review':
          rt.reviewNow(id);
          break;
        default:
          throw new Error('Bilinmeyen işlem');
      }
      return { ok: true };
    }
    if (path === '/api/insights/refresh') {
      if (rt.youtube.status().connected) await rt.refreshStats();
      return { insights: await rt.refreshInsights(true) };
    }
    if (path === '/api/youtube/connect') return { url: rt.youtube.authUrl(`http://127.0.0.1:${port}`) };
    if (path === '/api/youtube/disconnect') {
      rt.youtube.disconnect();
      log.info('YouTube bağlantısı kesildi');
      return { ok: true };
    }
    if (path === '/api/open-folder') {
      const dir = s('which') === 'music' ? rt.paths.musicDir : rt.paths.home;
      opts.openPath?.(dir);
      return { ok: true, path: dir, opened: Boolean(opts.openPath) };
    }
    return undefined;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      // Blocks DNS rebinding: only answer requests addressed to this local server.
      const host = req.headers.host ?? '';
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return json(res, 403, { error: 'Yasak' });

      if (req.method === 'POST') {
        // A custom header forces a CORS preflight, which this server never approves, so other sites cannot post here.
        if (req.headers['x-shorts-bot'] !== '1' || !String(req.headers['content-type']).startsWith('application/json')) {
          return json(res, 403, { error: 'Yasak' });
        }
        const out = await post(url.pathname, await readJson(req));
        return out === undefined ? json(res, 404, { error: 'Bulunamadı' }) : json(res, 200, out);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'İzin verilmeyen istek' });

      if (url.pathname === '/') {
        // Google sends the user back here after the YouTube consent screen.
        if (url.searchParams.has('state') && (url.searchParams.has('code') || url.searchParams.has('error'))) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          try {
            const channel = await rt.youtube.finishAuth(url.searchParams);
            log.ok(`YouTube kanalı bağlandı: ${channel}`);
            return res.end(page('YouTube bağlandı', `Kanal: <b>${esc(channel)}</b>. Bu sekmeyi kapatıp Shorts Bot’a dönebilirsin.`, true));
          } catch (e) {
            log.error(`YouTube bağlanamadı: ${(e as Error).message}`);
            return res.end(page('YouTube bağlanamadı', esc((e as Error).message), false));
          }
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy':
            "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; media-src 'self' https:; img-src 'self' data: https:",
        });
        return res.end(readFileSync(opts.htmlPath));
      }

      if (url.pathname === '/api/status') return json(res, 200, rt.status());
      if (url.pathname === '/api/settings') return json(res, 200, { ...rt.settingsView(), desktop: Boolean(opts.desktop) });
      if (url.pathname === '/api/options') {
        return json(res, 200, {
          opusModels: OPUS_MODELS,
          opusGenres: OPUS_GENRES,
          clipBuckets: Object.keys(CLIP_BUCKETS),
          claudeModels: CLAUDE_MODELS,
          elevenModels: ELEVEN_MODELS,
          categories: CATEGORIES,
          languages: LANGUAGES,
        });
      }
      if (url.pathname === '/api/voices') return json(res, 200, { voices: await rt.voices() });

      if (url.pathname.startsWith('/media/')) {
        const file = resolve(mediaRoot, decodeURIComponent(url.pathname.slice('/media/'.length)));
        if (!file.startsWith(mediaRoot + sep) || !existsSync(file) || !statSync(file).isFile()) return json(res, 404, { error: 'Bulunamadı' });
        return serveFile(req, res, file);
      }

      json(res, 404, { error: 'Bulunamadı' });
    } catch (e) {
      json(res, 400, { error: (e as Error).message });
    }
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      port = (server.address() as AddressInfo).port;
      resolvePromise({ port, close: () => server.close() });
    });
  });
}

export const dashboardHtml = (appRoot: string) => join(appRoot, 'src', 'dashboard', 'index.html');
