import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { probe } from '../src/ffmpeg';
import { Runtime } from '../src/runtime';
import { DEFAULTS, writeSettings } from '../src/settings';
import { SCRIPT, startFakes, tempDir } from './helpers';

let fakes: Awaited<ReturnType<typeof startFakes>>;
let rt: Runtime;
let home: string;

before(async () => {
  home = tempDir('e2e');
  fakes = await startFakes(home, 6);
  writeSettings(join(home, 'settings.json'), {
    ...DEFAULTS,
    opusApiKey: 'opus-key',
    anthropicApiKey: 'sk-ant-test',
    elevenApiKey: 'el-key',
    voiceId: 'V1',
    voiceName: 'Ahmet',
    googleClientId: '123-abc.apps.googleusercontent.com',
    autoPrepare: false,
    musicVolume: 0,
  });
  rt = new Runtime({
    home,
    assetsDir: join(process.cwd(), 'assets'),
    endpoints: fakes.endpoints,
    google: fakes.google,
    tickMs: 3_600_000,
    opusPollMs: 0,
    uploadRetryDelayMs: 5,
  });
  await rt.start();
  await rt.idle();
});

after(async () => {
  rt?.stop();
  await rt?.idle();
  await fakes?.close();
});

test('a link becomes clips, a clip becomes a narrated short, and the short is scheduled on YouTube', async () => {
  // 1. Source → OpusClip project → clips in OpusClip's order
  rt.addSource('https://www.youtube.com/watch?v=abc123', 'Derbi, 2. yarı', 'goller');
  await rt.idle();
  const create = fakes.rec.opusCreate[0] as { videoUrl: string; curationPref: Record<string, unknown>; renderPref: Record<string, unknown>; importPref: Record<string, unknown> };
  assert.equal(create.videoUrl, 'https://www.youtube.com/watch?v=abc123');
  assert.deepEqual(create.curationPref.clipDurations, [[0, 30], [30, 60]]);
  assert.equal(create.curationPref.model, 'ClipAnything');
  assert.equal(create.curationPref.customPrompt, 'goller');
  assert.deepEqual(create.renderPref, { layoutAspectRatio: 'portrait', enableCaption: false });
  assert.equal(rt.store.data.sources[0].stage, 'processing');

  await rt.tick(); // still curating
  assert.equal(rt.store.data.sources[0].opusStage, 'CURATE');
  await rt.tick(); // complete
  assert.equal(rt.store.data.sources[0].stage, 'complete');
  assert.deepEqual(rt.store.data.clips.map((c) => [c.key, c.rank]), [['P1.CU1', 1], ['P1.CU2', 2]]);

  // 2. Draft: download, frames → Claude, voice → ElevenLabs, captions, render
  const d = rt.draftClip('P1.CU1', 'oyuncu adını söyleme');
  await rt.idle();
  assert.equal(d.status, 'ready', d.error ?? '');
  assert.equal(d.hook, SCRIPT.hook);
  assert.equal(d.narration, SCRIPT.narration);
  assert.deepEqual(d.tags, ['futbol', 'gol', 'süper lig', 'derbi']);

  const ask = fakes.rec.claude[0] as {
    model: string;
    fallbacks: string;
    output_config: { effort: string; format: { type: string } };
    messages: { content: { type: string; text?: string }[] }[];
  };
  assert.equal(ask.model, 'claude-opus-5-5');
  assert.equal(ask.fallbacks, 'default');
  assert.equal(ask.output_config.effort, 'medium');
  assert.equal(ask.output_config.format.type, 'json_schema');
  assert.equal(ask.messages[0].content.filter((b) => b.type === 'image').length, 4);
  const text = ask.messages[0].content.find((b) => b.type === 'text')?.text ?? '';
  assert.match(text, /Derbi, 2\. yarı/);
  assert.match(text, /oyuncu adını söyleme/);
  assert.match(text, /What a goal/);
  assert.match(String(fakes.rec.claudeHeaders[0]['anthropic-beta']), /server-side-fallback-2026-07-01/);

  const voice = fakes.rec.eleven[0] as { text: string; model_id: string; voice_settings: { speed: number }; language_code?: string };
  assert.equal(voice.text, SCRIPT.narration);
  assert.equal(voice.model_id, 'eleven_multilingual_v2');
  assert.equal(voice.language_code, undefined);

  const final = await probe(join(home, 'media', 'drafts', d.id, 'final.mp4'));
  assert.equal(final.width, 1080);
  assert.equal(final.height, 1920);
  assert.ok(final.hasAudio);
  assert.ok(Math.abs(final.duration - 6) < 0.3, `duration ${final.duration}`);
  const ass = readFileSync(join(home, 'media', 'drafts', d.id, 'subs.ass'), 'utf8');
  assert.match(ass, /BU GOL TARİHE GEÇTİ/);
  assert.match(ass, /GÖRDÜNÜZ/);

  // 3. Editing only the YouTube title keeps the video; editing the narration re-voices it.
  rt.saveDraft(d.id, { title: 'Yeni başlık' });
  assert.equal(d.status, 'ready');
  rt.saveDraft(d.id, { narration: 'Kısa yeni metin burada.' });
  assert.equal(d.status, 'queued');
  await rt.idle();
  assert.equal(d.status, 'ready', d.error ?? '');
  assert.equal(fakes.rec.eleven.length, 2);
  assert.equal(fakes.rec.claude.length, 1);

  // 4. Connect YouTube (desktop OAuth with PKCE)
  assert.throws(() => rt.approveDraft(d.id), /YouTube kanalını bağla/);
  const auth = new URL(rt.youtube.authUrl('http://127.0.0.1:4555'));
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('access_type'), 'offline');
  assert.match(auth.searchParams.get('scope') ?? '', /youtube\.upload/);
  const channel = await rt.youtube.finishAuth(new URLSearchParams({ code: 'CODE1', state: auth.searchParams.get('state') ?? '' }));
  assert.equal(channel, 'Test Kanal');
  const exchange = fakes.rec.tokenRequests[0];
  assert.equal(exchange.get('redirect_uri'), 'http://127.0.0.1:4555');
  assert.ok((exchange.get('code_verifier') ?? '').length >= 43);

  // 5. Approve → uploaded now, private until the slot (resumes after a dropped connection)
  const slot = rt.approveDraft(d.id);
  await rt.tick();
  await rt.idle();
  assert.equal(d.status, 'scheduled', d.error ?? '');
  assert.equal(d.youtubeId, 'VID1');
  const init = fakes.rec.uploadInit[0] as { snippet: Record<string, unknown>; status: Record<string, unknown> };
  assert.equal(init.status.privacyStatus, 'private');
  assert.equal(init.status.publishAt, slot);
  assert.equal(init.status.selfDeclaredMadeForKids, false);
  assert.equal(init.status.containsSyntheticMedia, false);
  assert.equal(init.snippet.title, 'Yeni başlık');
  assert.equal(init.snippet.categoryId, '17');
  assert.match(String(init.snippet.description), /#shorts$/);
  const file = readFileSync(join(home, 'media', 'drafts', d.id, 'final.mp4'));
  assert.equal(fakes.rec.uploadHeaders[0]['x-upload-content-length'], String(file.length));
  assert.ok(fakes.rec.uploaded[0].equals(file), 'uploaded bytes match the video after resuming');

  // 6. The next approved video goes N days later at the same hour.
  const d2 = rt.draftClip('P1.CU2');
  await rt.idle();
  assert.equal(d2.status, 'ready', d2.error ?? '');
  const [a, b] = [new Date(slot), new Date(rt.approveDraft(d2.id))];
  assert.equal(b.getHours(), a.getHours());
  assert.equal(Math.round((b.getTime() - a.getTime()) / 86_400_000), 2);
});
