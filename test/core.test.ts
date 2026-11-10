import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outputSeconds } from '../src/ffmpeg';
import { nextSlot } from '../src/schedule';
import { applySettingsInput, DEFAULTS } from '../src/settings';
import { assTime, buildAss, chunkWords, wordsFromAlignment } from '../src/subtitles';
import { cleanText, fitTags } from '../src/youtube';
import { fakeAlignment } from './helpers';

test('words come from the character timings, punctuation marks phrase ends', () => {
  const w = wordsFromAlignment(fakeAlignment('Bu gol, “inanılmaz”! İzle.', 0.1));
  assert.deepEqual(w.map((x) => x.text), ['Bu', 'gol', 'inanılmaz!', 'İzle']);
  assert.deepEqual(w.map((x) => x.brk), [false, true, true, true]);
  assert.equal(w[0].start, 0);
  assert.equal(w[0].end, 0.2);
  assert.equal(w[1].start, 0.3);
});

test('captions show at most three short words and never run past a phrase end', () => {
  const words = wordsFromAlignment(fakeAlignment('Top ceza sahasında bir dokunuş ve gol. Herkes ayakta', 0.05));
  const chunks = chunkWords(words);
  assert.ok(chunks.every((c) => c.length <= 3));
  assert.ok(chunks.every((c) => c.map((w) => w.text).join(' ').length <= 16 || c.length === 1));
  const golChunk = chunks.find((c) => c.some((w) => w.text === 'gol'));
  assert.equal(golChunk?.at(-1)?.text, 'gol');
});

test('ASS subtitles: Turkish upper case, highlighted word, headline box', () => {
  const ass = buildAss({
    words: wordsFromAlignment(fakeAlignment('inanılmaz bir gol', 0.1)),
    hook: 'şimdi izle',
    hookSeconds: 0,
    duration: 4,
    position: 'lower',
    highlight: '#FFD400',
    locale: 'tr',
  });
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /Dialogue: 1,0:00:00\.00,0:00:04\.00,Hook,,0,0,0,,ŞİMDİ İZLE/);
  // "İNANILMAZ BİR GOL" is over 16 characters, so GOL gets its own caption.
  assert.match(ass, /,Cap,,0,0,0,,\{\\c&H00D4FF&\\fscx112\\fscy112\}İNANILMAZ\{\\r\} BİR\n/);
  assert.match(ass, /,Cap,,0,0,0,,İNANILMAZ \{\\c&H00D4FF&\\fscx112\\fscy112\}BİR\{\\r\}\n/);
  assert.match(ass, /,Cap,,0,0,0,,\{\\c&H00D4FF&\\fscx112\\fscy112\}GOL\{\\r\}\n/);
  assert.equal((ass.match(/,Cap,/g) ?? []).length, 3);
  assert.equal(assTime(3725.456), '1:02:05.46');
});

test('video length follows the narration', () => {
  assert.equal(outputSeconds(30, 26), 29);
  assert.equal(outputSeconds(60, 20), 23);
  assert.equal(outputSeconds(10, 12), 12.8);
});

test('publish slots: every N days at the set time, never in the past', () => {
  const at = (s: string) => new Date(s);
  assert.equal(nextSlot({ now: at('2026-11-10T10:00:00'), intervalDays: 2, time: '19:00' }).getTime(), at('2026-11-10T19:00:00').getTime());
  assert.equal(nextSlot({ now: at('2026-11-10T18:45:00'), intervalDays: 2, time: '19:00' }).getTime(), at('2026-11-11T19:00:00').getTime());
  assert.equal(
    nextSlot({ now: at('2026-11-10T10:00:00'), lastSlot: at('2026-11-12T19:00:00'), intervalDays: 2, time: '19:00' }).getTime(),
    at('2026-11-14T19:00:00').getTime(),
  );
  // After a long gap the channel restarts at the next free time instead of a date in the past.
  assert.equal(
    nextSlot({ now: at('2026-11-10T10:00:00'), lastSlot: at('2026-10-01T19:00:00'), intervalDays: 2, time: '19:00' }).getTime(),
    at('2026-11-10T19:00:00').getTime(),
  );
});

test('settings: blank secrets keep the stored key, bad values are rejected in Turkish', () => {
  const s = applySettingsInput({ ...DEFAULTS, opusApiKey: 'old' }, { opusApiKey: '', publishTime: '08:30', intervalDays: 3 });
  assert.equal(s.opusApiKey, 'old');
  assert.equal(s.publishTime, '08:30');
  assert.equal(s.intervalDays, 3);
  assert.throws(() => applySettingsInput(DEFAULTS, { publishTime: '25:00' }), /SS:DD/);
  assert.throws(() => applySettingsInput(DEFAULTS, { googleClientId: 'abc' }), /apps\.googleusercontent\.com/);
  assert.throws(() => applySettingsInput(DEFAULTS, { opusClipBuckets: [] }), /klip süresi/);
  assert.throws(() => applySettingsInput(DEFAULTS, { voiceSpeed: 2 }), /Konuşma hızı/);
});

test('YouTube limits: tags fit the 500-character budget, < and > are removed', () => {
  const many = Array.from({ length: 80 }, (_, i) => `etiket numarası ${i}`);
  const tags = fitTags(['#futbol', 'futbol', 'Süper Lig', ...many]);
  assert.equal(tags[0], 'futbol');
  assert.equal(tags[1], 'Süper Lig');
  const cost = tags.reduce((n, t, i) => n + t.length + (t.includes(' ') ? 2 : 0) + (i ? 1 : 0), 0);
  assert.ok(cost <= 500);
  assert.equal(cleanText('a <b> c', 100), 'a b c');
  assert.equal(Buffer.byteLength(cleanText('ğğğğ', 5)), 4);
});
