import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { probe } from '../src/ffmpeg';
import { Runtime } from '../src/runtime';
import { DEFAULTS, writeSettings } from '../src/settings';
import { LESSONS, SCRIPT, startFakes, tempDir } from './helpers';

let fakes: Awaited<ReturnType<typeof startFakes>>;
let rt: Runtime;
let home: string;
const notes: [string, string][] = [];

const text = (b: Record<string, unknown> | undefined) => {
  const c = (b?.messages as { content: string | { type: string; text?: string }[] }[])[0].content;
  return typeof c === 'string' ? c : c.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
};
const lookups = () => fakes.rec.videoLookups.filter((p) => p === 'processingDetails').length;

before(async () => {
  home = tempDir('learn');
  fakes = await startFakes(home, 6);
  writeSettings(join(home, 'settings.json'), {
    ...DEFAULTS,
    opusApiKey: 'opus-key',
    anthropicApiKey: 'sk-ant-test',
    elevenApiKey: 'el-key',
    voiceId: 'V1',
    googleClientId: '123-abc.apps.googleusercontent.com',
    autoPrepare: false,
    musicVolume: 0,
    reviewMode: 'off',
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
  rt.addSource('https://www.youtube.com/watch?v=abc123', 'Derbi', '');
  await rt.idle();
  await rt.tick();
  await rt.tick();
  assert.equal(rt.store.data.sources[0].stage, 'complete');
  const auth = new URL(rt.youtube.authUrl('http://127.0.0.1:4555'));
  await rt.youtube.finishAuth(new URLSearchParams({ code: 'C1', state: auth.searchParams.get('state') ?? '' }));
});

after(async () => {
  rt?.stop();
  await rt?.idle();
  await fakes?.close();
});

test('each short gets a cover (a clean frame plus the cover text) that is set on YouTube once processing is done', async () => {
  const d = rt.draftClip('P1.CU1');
  await rt.idle();
  assert.equal(d.status, 'ready', d.error ?? '');
  assert.equal(d.coverText, SCRIPT.coverText);
  assert.equal(d.hasCover, true);
  // Claude picked still 2 of the 4 it saw: the middle of the second quarter of the 6-second clip.
  assert.ok(Math.abs((d.coverAt ?? 0) - 2.25) < 0.05, `coverAt ${d.coverAt}`);
  const schema = (fakes.rec.claude[0] as { output_config: { format: { schema: { properties: Record<string, unknown> } } } }).output_config.format.schema;
  assert.ok(schema.properties.coverText && schema.properties.coverFrame, 'the script asks for a cover text and a frame');

  const dir = join(home, 'media', 'drafts', d.id);
  const cover = await probe(join(dir, 'cover.jpg'));
  assert.deepEqual([cover.width, cover.height], [1080, 1920]);
  assert.match(readFileSync(join(dir, 'cover.ass'), 'utf8'), /Cover,,0,0,0,,İSTANBUL SALLANDI$/m);
  assert.match(String(rt.status().drafts.find((x) => x.id === d.id)?.coverSrc), new RegExp(`^/media/drafts/${d.id}/cover\\.jpg\\?v=`));

  // Editing only the cover text redraws the cover; the video, the voice and the status stay.
  const video = statSync(join(dir, 'final.mp4')).mtimeMs;
  const voices = fakes.rec.eleven.length;
  rt.saveDraft(d.id, { coverText: 'derbi bitmedi' });
  assert.equal(d.status, 'ready');
  await rt.idle();
  assert.match(readFileSync(join(dir, 'cover.ass'), 'utf8'), /Cover,,0,0,0,,DERBİ BİTMEDİ$/m);
  assert.equal(statSync(join(dir, 'final.mp4')).mtimeMs, video);
  assert.equal(fakes.rec.eleven.length, voices);
  assert.equal(d.status, 'ready');

  // While YouTube is still processing the upload, the cover waits.
  fakes.yt.processing = 'processing';
  rt.approveDraft(d.id);
  await rt.tick();
  await rt.idle();
  assert.equal(d.status, 'scheduled', d.error ?? '');
  assert.equal(d.youtubeId, 'VID1');
  await rt.tick();
  await rt.idle();
  assert.equal(lookups(), 1);
  assert.equal(d.thumbnailSet, undefined);
  assert.ok(d.nextThumbAt && Date.parse(d.nextThumbAt) > Date.now(), 'tries again in a few minutes');
  assert.equal(fakes.rec.thumbnails.length, 0);

  fakes.yt.processing = 'succeeded';
  d.nextThumbAt = undefined; // skip the wait
  await rt.tick();
  await rt.idle();
  assert.equal(d.thumbnailSet, true, d.thumbnailError ?? '');
  const sent = fakes.rec.thumbnails[0];
  assert.equal(sent.videoId, 'VID1');
  assert.equal(sent.type, 'image/jpeg');
  assert.ok(sent.body.equals(readFileSync(join(dir, 'cover.jpg'))), 'the uploaded image is the cover');
  await rt.tick();
  await rt.idle();
  assert.equal(fakes.rec.thumbnails.length, 1, 'set once');
});

test('YouTube results are collected, turned into lessons, and the next script is written with them', async () => {
  const d = rt.store.data.drafts[0];
  // Pretend the short went live 50 hours ago.
  d.slot = new Date(Date.now() - 50 * 3_600_000).toISOString();
  fakes.yt.videos.set('VID1', { views: 1520, likes: 96, comments: 12, uploadStatus: 'processed', privacy: 'public' });
  await rt.refreshStats();
  assert.deepEqual([d.stats?.views, d.stats?.likes, d.stats?.comments], [1520, 96, 12]);
  assert.deepEqual(d.early, { views: 1520, likes: 96, comments: 12, hoursLive: 50 }, 'the first check after 48 hours is kept for fair comparisons');
  assert.equal(d.ytProblem, undefined);

  // Later checks update the totals but keep the 48-hour numbers.
  fakes.yt.videos.set('VID1', { views: 2100, likes: 120, comments: 15, uploadStatus: 'processed', privacy: 'public' });
  await rt.refreshStats();
  assert.equal(d.stats?.views, 2100);
  assert.equal(d.early?.views, 1520);
  const [row] = rt.status().results;
  assert.deepEqual([row.title, row.views, row.earlyViews, row.opusRank], [SCRIPT.title, 2100, 1520, 1]);

  // One result is too few for lessons on their own; the owner can still ask for them.
  assert.equal(await rt.refreshInsights(), undefined);
  assert.equal(fakes.rec.lessons.length, 0);
  const ins = await rt.refreshInsights(true);
  assert.deepEqual(ins?.lessons, LESSONS);
  assert.equal(ins?.basedOn, 1);
  const ask = text(fakes.rec.lessons[0]);
  assert.match(ask, /"Sezonun golü bu mu\? ⚽" \| headline: Bu gol tarihe geçti \| opening: Bu golü gördünüz mü\?/);
  assert.match(ask, /views 2100 \(1520 at 48 h\) \| likes 120 \| comments 15 \| live 50 h/);

  // The next script sees the lessons.
  const d2 = rt.draftClip('P1.CU2');
  await rt.idle();
  assert.equal(d2.status, 'ready', d2.error ?? '');
  const brief = text(fakes.rec.claude.at(-1));
  assert.match(brief, /What this channel's real results have shown so far \(use it\):\n- Soruyla başlayan girişler daha çok izlendi\./);
  assert.doesNotMatch(brief, /most-watched shorts/, 'example openings start once there are a few results');
});

test('a channel that may not set custom covers is told once; the video stays scheduled', async () => {
  const d2 = rt.store.data.drafts.find((d) => d.clipKey === 'P1.CU2');
  assert.ok(d2);
  fakes.yt.thumbnailStatus = 403;
  rt.approveDraft(d2.id);
  await rt.tick();
  await rt.idle();
  assert.equal(d2.youtubeId, 'VID2');
  await rt.tick();
  await rt.idle();
  assert.equal(d2.status, 'scheduled');
  assert.match(d2.thumbnailError ?? '', /youtube\.com\/verify/);
  assert.equal(notes.filter(([t]) => t === 'Kapak yüklenemedi').length, 1);
  const n = lookups();
  await rt.tick();
  await rt.idle();
  assert.equal(lookups(), n, 'no more attempts after a permission error');
});

test('a short YouTube turned down is flagged and the owner is told once', async () => {
  const d = rt.store.data.drafts[0];
  fakes.yt.videos.set('VID1', { views: 2100, likes: 120, comments: 15, uploadStatus: 'rejected', privacy: 'private', rejectionReason: 'copyright' });
  await rt.refreshStats();
  assert.equal(d.ytProblem, 'YouTube videoyu reddetti: telif hakkı');
  assert.equal(notes.filter(([t]) => t === 'YouTube’da bir videoda sorun var').length, 1);
  await rt.refreshStats();
  assert.equal(notes.filter(([t]) => t === 'YouTube’da bir videoda sorun var').length, 1, 'the same problem is reported once');
  fakes.yt.videos.set('VID1', { views: 2100, likes: 120, comments: 15, uploadStatus: 'processed', privacy: 'public' });
  await rt.refreshStats();
  assert.equal(d.ytProblem, undefined, 'cleared once it is fixed');
});
