import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Runtime } from '../src/runtime';
import { DEFAULTS, writeSettings } from '../src/settings';
import { startFakes, tempDir } from './helpers';

let fakes: Awaited<ReturnType<typeof startFakes>>;
let rt: Runtime;
const notes: [string, string][] = [];

before(async () => {
  const home = tempDir('agents');
  fakes = await startFakes(home, 6);
  writeSettings(join(home, 'settings.json'), {
    ...DEFAULTS,
    opusApiKey: 'opus-key',
    anthropicApiKey: 'sk-ant-test',
    elevenApiKey: 'el-key',
    voiceId: 'V1',
    googleClientId: '123-abc.apps.googleusercontent.com',
    musicVolume: 0,
    reviewMode: 'agents',
    reviewMinScore: 7,
    reviewRevisions: 1,
    opusTopN: 1,
    planAhead: 1,
  });
  rt = new Runtime({
    home,
    assetsDir: join(process.cwd(), 'assets'),
    endpoints: fakes.endpoints,
    google: fakes.google,
    tickMs: 3_600_000,
    opusPollMs: 0,
    uploadRetryDelayMs: 5,
    notify: (title, body) => notes.push([title, body]),
  });
  await rt.start();
  await rt.idle();
});

after(async () => {
  rt?.stop();
  await rt?.idle();
  await fakes?.close();
});

test('the review panel debates, sends a weak version back for a rewrite, then publishes the better one by itself', async () => {
  // First panel (6 requests): two reviewers say no. After the rewrite (next 6): everyone says yes.
  fakes.panel.opinion = (n) =>
    n < 6 && n % 3 !== 0
      ? { score: 5, verdict: 'reject', comment: 'Giriş zayıf, ilk saniyede yakalamıyor.', fix: 'İlk cümle bir soruyla başlasın.' }
      : { score: n < 6 ? 7 : 8, verdict: 'approve', comment: 'Yayınlanabilir.', fix: '' };

  const auth = new URL(rt.youtube.authUrl('http://127.0.0.1:4555'));
  await rt.youtube.finishAuth(new URLSearchParams({ code: 'C1', state: auth.searchParams.get('state') ?? '' }));

  rt.addSource('https://www.youtube.com/watch?v=xyz', 'Derbi', '');
  for (let i = 0; i < 6; i++) {
    await rt.tick();
    await rt.idle();
  }

  // Only OpusClip's best clip is used; the rest are set aside.
  assert.deepEqual(rt.store.data.clips.map((c) => [c.key, c.status]), [['P1.CU1', 'drafted'], ['P1.CU2', 'skipped']]);
  assert.equal(rt.store.data.drafts.length, 1, 'planAhead=1: one short in the pipeline at a time');
  const d = rt.store.data.drafts[0];

  // Two full panels: 3 reviewers × 2 rounds each.
  assert.equal(fakes.rec.reviews.length, 12);
  const text = (b: Record<string, unknown>) =>
    ((b.messages as { content: { type: string; text?: string }[] }[])[0].content)
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
  const round1 = fakes.rec.reviews.slice(0, 3).map(text);
  const round2 = fakes.rec.reviews.slice(3, 6).map(text);
  assert.ok(round1.every((t) => /round 1/.test(t) && !/round 2/.test(t)));
  assert.ok(round2.every((t) => /This is round 2/.test(t)));
  // In round 2 each reviewer reads the other two, not itself.
  assert.match(round2[0], /- Editör: 5\/10, reject\. Giriş zayıf/);
  assert.match(round2[0], /- Kanal yöneticisi: 5\/10, reject/);
  assert.doesNotMatch(round2[0], /- İzleyici:/);
  // Reviewers see the finished video (4 stills) and the texts.
  const first = fakes.rec.reviews[0] as { messages: { content: { type: string }[] }[] };
  assert.equal(first.messages[0].content.filter((c) => c.type === 'image').length, 4);
  assert.match(round1[0], /Narration: Bu golü gördünüz mü/);
  assert.match(round1[0], /Thumbnail text \(big capitals on a clean frame\): istanbul sallandı/);

  // The rejection fed a rewrite with the panel's fix.
  assert.equal(fakes.rec.claude.length, 2);
  const rewrite = text(fakes.rec.claude[1]);
  assert.match(rewrite, /Changes the review panel asked for/);
  assert.match(rewrite, /İlk cümle bir soruyla başlasın/);
  assert.match(rewrite, /earlier version was turned down/);
  assert.equal(d.revisions, 1);

  // Second panel approved → booked and uploaded without the owner.
  assert.equal(d.review?.verdict, 'approve');
  assert.equal(d.review?.approvals, 3);
  assert.equal(d.review?.score, 8);
  assert.equal(d.review?.opinions.length, 6);
  assert.equal(d.status, 'scheduled', d.error ?? '');
  assert.equal(d.youtubeId, 'VID1');
  assert.equal((fakes.rec.uploadInit[0] as { status: { publishAt: string } }).status.publishAt, d.slot);
  assert.ok(notes.some(([t]) => t === 'Ajanlar onayladı'), JSON.stringify(notes));
});

test('advisory mode: the panel only comments and the owner decides', async () => {
  await rt.saveSettings({ reviewMode: 'advisory' });
  fakes.panel.opinion = () => ({ score: 9, verdict: 'approve', comment: 'Çok iyi.', fix: '' });
  rt.skipClip('P1.CU2', false);
  const d = rt.draftClip('P1.CU2');
  await rt.idle();
  assert.equal(d.review?.verdict, 'approve');
  assert.equal(d.status, 'ready', 'advisory: approved by the panel but waiting for the owner');
  assert.equal(d.youtubeId, undefined);
});
