import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { dashboardHtml, startDashboard } from '../src/dashboard/server';
import { Runtime } from '../src/runtime';
import { sendJson, serve, tempDir, type Fake } from './helpers';

let rt: Runtime;
let server: { port: number; close: () => void };
let claude: Fake;

before(async () => {
  const home = tempDir('srv');
  // Answers the model lookup the settings page uses to check a Claude key.
  claude = await serve((req, res) => {
    const key = req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer /, '');
    if (key !== 'sk-ant-secret-1234') {
      return sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    }
    sendJson(res, 200, { type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-10-01T00:00:00Z' });
  });
  rt = new Runtime({ home, assetsDir: join(process.cwd(), 'assets'), tickMs: 3_600_000, endpoints: { claude: claude.url } });
  await rt.start();
  server = await startDashboard(rt, { host: '127.0.0.1', port: 0, htmlPath: dashboardHtml(process.cwd()) });
  mkdirSync(join(home, 'media', 'drafts', 'abc'), { recursive: true });
  writeFileSync(join(home, 'media', 'drafts', 'abc', 'final.mp4'), Buffer.from('0123456789'));
});

after(async () => {
  server?.close();
  rt?.stop();
  await claude?.close();
});

function call(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, path, method: opts.method ?? 'GET', headers: { Host: `127.0.0.1:${server.port}`, ...opts.headers } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

const post = (path: string, body: unknown, headers: Record<string, string> = { 'X-Shorts-Bot': '1' }) =>
  call(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('panel loads and reports what is missing from the setup', async () => {
  const page = await call('/');
  assert.equal(page.status, 200);
  assert.match(page.body, /Shorts Bot/);
  assert.match(String(page.headers['content-security-policy']), /media-src 'self' https:/);
  const s = JSON.parse((await call('/api/status')).body);
  // OpusClip is optional: video files go to the clip agent, and the key is only asked for once a link is added.
  assert.deepEqual(s.setup.map((x: { section: string }) => x.section), ['claude', 'eleven', 'youtube']);
});

test('only this local panel may change anything', async () => {
  assert.equal((await post('/api/settings', { intervalDays: 3 }, {})).status, 403);
  assert.equal((await call('/api/status', { headers: { Host: 'evil.example:80' } })).status, 403);
  const ok = await post('/api/settings', { intervalDays: 3, publishTime: '20:30' });
  assert.equal(ok.status, 200);
  assert.equal(rt.settings.intervalDays, 3);
  const bad = await post('/api/settings', { publishTime: '99:00' });
  assert.equal(bad.status, 400);
  assert.match(JSON.parse(bad.body).error, /SS:DD/);
});

test('a wrong API key is refused and nothing is saved', async () => {
  const r = await post('/api/settings', { anthropicApiKey: 'sk-ant-wrong', intervalDays: 5 });
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.body).error, /Claude anahtarı doğrulanamadı, ayarlar kaydedilmedi: Claude API anahtarı geçersiz/);
  assert.equal(rt.settings.anthropicApiKey, '');
  assert.notEqual(rt.settings.intervalDays, 5);
});

test('a working key is saved; secrets never reach the panel', async () => {
  assert.equal((await post('/api/settings', { anthropicApiKey: 'sk-ant-secret-1234' })).status, 200);
  const s = JSON.parse((await call('/api/settings')).body);
  assert.equal(s.anthropicApiKey, undefined);
  assert.equal(s.anthropicKeyHint, '••••1234');
});

test('videos are served with byte ranges and nothing outside the media folder', async () => {
  const part = await call('/media/drafts/abc/final.mp4', { headers: { Range: 'bytes=2-5' } });
  assert.equal(part.status, 206);
  assert.equal(part.body, '2345');
  assert.equal(part.headers['content-range'], 'bytes 2-5/10');
  assert.equal((await call('/media/..%2Fsettings.json')).status, 404);
  assert.equal((await call('/media/%2e%2e/%2e%2e/etc/passwd')).status, 404);
});

test('adding a source without an OpusClip key explains what to do', async () => {
  const r = await post('/api/sources', { url: 'https://www.youtube.com/watch?v=x' });
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.body).error, /OpusClip/);
});

test('a forged OAuth callback shows an error page', async () => {
  const r = await call('/?state=forged&code=abc');
  assert.equal(r.status, 200);
  assert.match(r.body, /YouTube bağlanamadı/);
});
