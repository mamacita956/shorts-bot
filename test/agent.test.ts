import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { probe, runFfmpeg } from '../src/ffmpeg';
import { Runtime } from '../src/runtime';
import { DEFAULTS, writeSettings } from '../src/settings';
import { makeMatch, startFakes, tempDir } from './helpers';

let fakes: Awaited<ReturnType<typeof startFakes>>;
let rt: Runtime;
let home: string;
let match: string;
const notes: [string, string][] = [];

type Block = { type: string; text?: string };
const blocks = (b: Record<string, unknown>) => (b.messages as { content: Block[] }[])[0].content;
const text = (b: Record<string, unknown>) => blocks(b).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const images = (b: Record<string, unknown>) => blocks(b).filter((c) => c.type === 'image').length;

/** Average brightness (0-255) of a strip of the video's first second. */
async function brightness(file: string, y: number, h: number): Promise<number> {
  let yavg = -1;
  await runFfmpeg(['-ss', '1', '-i', file, '-frames:v', '1', '-vf', `crop=1080:${h}:0:${y},signalstats,metadata=print:key=lavfi.signalstats.YAVG`, '-f', 'null', '-'], {
    onLine: (l) => {
      const m = /YAVG=([\d.]+)/.exec(l);
      if (m) yavg = Number(m[1]);
    },
  });
  return yavg;
}

before(async () => {
  home = tempDir('agent');
  fakes = await startFakes(home, 6);
  match = join(home, 'Derbi maçı.mp4');
  await makeMatch(match, 40);
  writeSettings(join(home, 'settings.json'), {
    ...DEFAULTS,
    anthropicApiKey: 'sk-ant-test',
    elevenApiKey: 'el-key',
    voiceId: 'V1',
    autoPrepare: false,
    musicVolume: 0,
    reviewMode: 'off',
    opusTopN: 1,
    opusClipBuckets: ['0-30'],
    clipWishes: 'Sadece goller ve kurtarışlar.',
  });
  rt = new Runtime({
    home,
    assetsDir: join(process.cwd(), 'assets'),
    endpoints: fakes.endpoints,
    google: fakes.google,
    tickMs: 3_600_000,
    opusPollMs: 0,
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

test('a video file is watched by Claude: candidates first, then a close look, then scored clips cut from the file', async () => {
  // No OpusClip key is needed for a file; a link still asks for one.
  assert.throws(() => rt.addSource('https://www.youtube.com/watch?v=abc', '', ''), /OpusClip/);
  assert.equal(rt.setupIssues().some((i) => i.section === 'opus'), false);

  const src = rt.addSource(`"${match}"`, 'Galatasaray - Fenerbahçe, 2. yarı', '');
  assert.equal(src.kind, 'file');
  assert.equal(src.file, match);
  await rt.idle();
  assert.equal(src.stage, 'complete', src.error ?? '');
  assert.equal(src.clipCount, 2);
  assert.ok(notes.some(([t]) => t === 'Klipler hazır'));

  // The speech was transcribed from a small mono MP3 of the soundtrack.
  assert.equal(fakes.rec.stt.length, 1);
  assert.equal(fakes.rec.stt[0].fields.model_id, 'scribe_v3');
  assert.equal(fakes.rec.stt[0].fields.tag_audio_events, 'true');
  assert.ok(fakes.rec.stt[0].bytes > 10_000 && fakes.rec.stt[0].bytes < 400_000, `audio bytes ${fakes.rec.stt[0].bytes}`);

  // Stage 1: the whole video as stamped stills, with loudness and the transcript.
  const [first, second] = fakes.rec.finder;
  assert.equal(first.stage, 1);
  const t1 = text(first.body);
  assert.equal(images(first.body), 1, 'a 40-second video fits on one contact sheet');
  assert.match(t1, /Sheet 1: 0:00-0:3\d/);
  assert.match(t1, /What the owner wants in the clips: Sadece goller ve kurtarışlar\./);
  assert.match(t1, /Owner's note about this video: Galatasaray - Fenerbahçe, 2\. yarı/);
  assert.match(t1, /Each short is 10-30 seconds long/);
  assert.match(t1, /Loudest stretches: 0:(1[89]|2[0-3]) \(\+\d+ dB\)/);
  assert.match(t1, /\[0:17\] Ceza sahasına giriyor ve GOOOL! \(cheering\)/);
  assert.match(t1, /^0:00 {2}0 9 9 0$/m, 'loudness: quiet, loud in the 2nd and 3rd ten seconds, quiet again');
  assert.match(t1, /List up to 10 candidate moments/, '2 × (1 clip + 2 spares) + 4');
  const opts = first.body as { model: string; output_config: { effort: string } };
  assert.equal(opts.model, 'claude-opus-5-5');
  assert.equal(opts.output_config.effort, 'high');

  // Stage 2: each candidate second by second.
  assert.equal(second.stage, 2);
  const t2 = text(second.body);
  assert.match(t2, /Candidate 1: "Son dakika golü" \(0:14-0:30\)/);
  assert.match(t2, /Stills 0:06-0:38:/);
  assert.match(t2, /Candidate 2: "Orta saha" \(0:01-0:09\)/);
  assert.match(t2, /Loudness per second \(0-9\) from 0:06: (\d ){12}9/);
  assert.match(t2, /Pick up to 3 clips/);
  assert.equal(images(second.body), 3, 'candidate 1: 32 s = 2 sheets, candidate 2: 17 s = 1 sheet');

  // The clips: best score first, cut from the file, with what was said in them.
  const clips = rt.store.data.clips.filter((c) => c.sourceId === src.id);
  assert.deepEqual(
    clips.map((c) => [c.key, c.rank, c.score, c.status, c.startSec, c.endSec]),
    [
      [`${src.id}.m1`, 1, 91, 'new', 15, 27],
      [`${src.id}.m2`, 2, 38, 'skipped', 1, 12],
    ],
  );
  assert.equal(clips[0].title, 'Ağları sarsan gol');
  assert.equal(clips[0].description, 'Atak, gol ve tribünün coşkusu tek klipte.');
  assert.equal(clips[0].text, 'Ceza sahasına giriyor ve GOOOL!');
  const cut = await probe(join(home, 'media', 'clips', `${src.id}_m1.mp4`));
  assert.ok(Math.abs(cut.duration - 12) < 0.3, `clip length ${cut.duration}`);
  assert.deepEqual([cut.width, cut.height], [1280, 720]);
  assert.ok(cut.hasAudio);
  // Only Claude's decision is kept from the work folder.
  const work = join(home, 'media', 'analysis', src.id);
  assert.ok(existsSync(join(work, 'result.json')));
  assert.ok(!existsSync(join(work, 'audio.mp3')) && !existsSync(join(work, 'overview')));
});

test('a landscape clip becomes a vertical short with the match in the middle over a blurred background', async () => {
  const key = rt.store.data.clips.find((c) => c.rank === 1 && c.score !== undefined)?.key ?? '';
  const d = rt.draftClip(key);
  await rt.idle();
  assert.equal(d.status, 'ready', d.error ?? '');
  const dir = join(home, 'media', 'drafts', d.id);
  const final = await probe(join(dir, 'final.mp4'));
  assert.deepEqual([final.width, final.height], [1080, 1920]);
  // Above the picture there is the blurred copy, not black bars.
  assert.ok((await brightness(join(dir, 'final.mp4'), 420, 120)) > 40, 'blurred background above the match');
  // Captions sit lower, under the picture.
  assert.match(readFileSync(join(dir, 'subs.ass'), 'utf8'), /^Style: Cap,.*,2,80,80,400,1$/m);
  const cover = await probe(join(dir, 'cover.jpg'));
  assert.deepEqual([cover.width, cover.height], [1080, 1920]);
});

test('deleting a file source never touches the video file', async () => {
  const src = rt.store.data.sources.find((s) => s.kind === 'file');
  assert.ok(src);
  rt.removeSource(src.id);
  assert.ok(existsSync(match), 'the user’s video is still there');
  assert.ok(!existsSync(join(home, 'media', 'analysis', src.id)));
  assert.ok(!existsSync(join(home, 'media', 'clips', `${src.id}_m2.mp4`)), 'unused clip removed');
  assert.ok(existsSync(join(home, 'media', 'clips', `${src.id}_m1.mp4`)), 'the drafted clip stays');
});

test('files that are not videos, or missing, are refused with a clear reason', () => {
  const doc = join(home, 'notlar.txt');
  writeFileSync(doc, 'not a video');
  assert.throws(() => rt.addSource(doc, '', ''), /video dosyası seç/);
  assert.throws(() => rt.addSource(join(home, 'yok.mp4'), '', ''), /Dosya bulunamadı/);
  assert.throws(() => rt.addSource(home, '', ''), /dosya değil/);
});
