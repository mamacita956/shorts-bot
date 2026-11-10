import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { OpusBusyError, OpusClient } from '../src/opus';
import { DEFAULTS } from '../src/settings';
import { YouTube } from '../src/youtube';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { sendJson, serve, tempDir, type Fake } from './helpers';

const fakes: Fake[] = [];
after(async () => {
  await Promise.all(fakes.map((f) => f.close()));
});

test('OpusClip: limits and errors come back as clear messages', async () => {
  let mode = 'busy';
  const f = await serve((req, res) => {
    if (mode === 'busy') return sendJson(res, 429, { message: 'too many' }, { 'X-Cap-Reason': 'concurrent' });
    if (mode === 'cap') return sendJson(res, 403, { code: 'API_MONTHLY_CAP_REACHED', reset_at: '2026-12-01T00:00:00Z' });
    if (mode === 'key') return sendJson(res, 401, { message: 'unauthorized' });
    sendJson(res, 400, { message: 'videoUrl must be a URL' });
  });
  fakes.push(f);
  const c = new OpusClient('k', '', f.url);
  await assert.rejects(c.createProject('https://youtu.be/x', DEFAULTS), (e) => e instanceof OpusBusyError && /4 proje/.test(e.message));
  mode = 'cap';
  await assert.rejects(c.createProject('https://youtu.be/x', DEFAULTS), /aylık API sınırı.*2026-12-01/);
  mode = 'key';
  await assert.rejects(c.getProject('P1'), /anahtarı geçersiz/);
  mode = 'bad';
  await assert.rejects(c.getProject('P1'), /OpusClip hatası 400: videoUrl must be a URL/);
});

test('OpusClip: clips are read page by page, ClipBasic gets no custom prompt', async () => {
  const bodies: Record<string, unknown>[] = [];
  const f = await serve((req, res, body) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'POST') {
      bodies.push(JSON.parse(body.toString()));
      return sendJson(res, 201, { id: 'P9', stage: 'QUEUED' });
    }
    const page = Number(url.searchParams.get('pageNum'));
    const size = Number(url.searchParams.get('pageSize'));
    const count = page === 1 ? size : page === 2 ? 3 : 0;
    sendJson(res, 200, Array.from({ length: count }, (_, i) => ({ id: `P9.C${page}-${i}`, durationMs: 1000 })));
  });
  fakes.push(f);
  const c = new OpusClient('k', 'org_1', f.url);
  const p = await c.createProject('https://youtu.be/x', { ...DEFAULTS, opusModel: 'ClipBasic', opusCaptions: true, opusBrandTemplateId: 'tpl-1' }, 'goller');
  assert.equal(p.projectId, 'P9');
  const b = bodies[0] as { curationPref: Record<string, unknown>; renderPref: Record<string, unknown>; brandTemplateId: string };
  assert.equal(b.curationPref.customPrompt, undefined);
  assert.deepEqual(b.renderPref, { layoutAspectRatio: 'portrait' });
  assert.equal(b.brandTemplateId, 'tpl-1');
  const clips = await c.listClips('P9');
  assert.equal(clips.length, 53);
  assert.equal(clips[0].id, 'P9.C1-0');
});

test('YouTube: an expired refresh token disconnects with a clear message', async () => {
  const f = await serve((req, res) => sendJson(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
  fakes.push(f);
  const dir = tempDir('yt');
  const tokenFile = join(dir, 'youtube.json');
  writeFileSync(tokenFile, JSON.stringify({ clientId: 'id.apps.googleusercontent.com', refreshToken: 'RT', connectedAt: '' }));
  const yt = new YouTube(tokenFile, () => ({ clientId: 'id.apps.googleusercontent.com', clientSecret: '' }), {
    auth: `${f.url}/auth`,
    token: `${f.url}/token`,
    api: f.url,
    upload: f.url,
  });
  assert.equal(yt.status().connected, true);
  writeFileSync(join(dir, 'v.mp4'), 'x');
  await assert.rejects(
    yt.upload(join(dir, 'v.mp4'), { title: 't', description: '', tags: [], categoryId: '17', language: 'tr', madeForKids: false, syntheticMedia: false }),
    /yeniden bağlan/,
  );
  assert.equal(yt.status().connected, false);
});

test('YouTube: a callback with a stale state is refused', async () => {
  const yt = new YouTube(join(tempDir('yt2'), 'youtube.json'), () => ({ clientId: 'id.apps.googleusercontent.com', clientSecret: '' }));
  yt.authUrl('http://127.0.0.1:1234');
  await assert.rejects(yt.finishAuth(new URLSearchParams({ code: 'x', state: 'wrong' })), /geçersiz/);
});
