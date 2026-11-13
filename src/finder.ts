import { readFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import { analyseAudio, clock, overviewInterval, overviewSheets, prepareWorkDir, windowSheets, type Sheet } from './analyze';
import { claudeError } from './claude';
import { ElevenClient, type Heard } from './eleven';
import { probe } from './ffmpeg';
import { LANGUAGES } from './settings';

/**
 * The clip agent: Claude "watches" a long video through time-stamped stills, the transcript and the loudness curve,
 * lists candidate moments, then looks at each one second by second and picks the final clips with a score.
 */

export interface Candidate {
  start: number;
  end: number;
  title: string;
  why: string;
}

export interface Pick {
  start: number;
  end: number;
  /** 0-100, how likely the clip is to do well as a short. */
  score: number;
  title: string;
  reason: string;
}

export interface Brief {
  language: string;
  style: string;
  /** What the owner wants in the clips. */
  wishes: string;
  /** Owner's note about this video. */
  note: string;
  lessons: string[];
  minSeconds: number;
  maxSeconds: number;
}

interface Window {
  from: number;
  to: number;
  sheets: Sheet[];
}

const CandidatesSchema = z.object({
  candidates: z.array(
    z.object({
      start: z.number().describe('Seconds from the start of the video'),
      end: z.number().describe('Seconds from the start of the video'),
      title: z.string().describe('Short working title'),
      why: z.string().describe('What you saw and heard that makes it stand out'),
    }),
  ),
});

const PicksSchema = z.object({
  clips: z.array(
    z.object({
      candidate: z.number().describe('Number of the candidate the clip comes from'),
      start: z.number().describe('Exact start, seconds from the start of the video'),
      end: z.number().describe('Exact end, seconds from the start of the video'),
      score: z.number().describe('0-100: how well this clip would do as a short on this channel'),
      title: z.string().describe('Title of the clip, at most 60 characters'),
      reason: z.string().describe('One or two sentences: what happens and why it is worth a short'),
    }),
  ),
});

type RawPick = z.infer<typeof PicksSchema>['clips'][number];

/** Loudness as 0-9 against this video's own range: 0 is its usual level or quieter, 9 its loudest moments. */
export function levels(loud: number[]): number[] {
  if (!loud.length) return [];
  const sorted = [...loud].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
  const base = q(0.5);
  const top = Math.max(q(0.995), base + 6);
  return loud.map((v) => Math.max(0, Math.min(9, Math.round((9 * (v - base)) / (top - base)))));
}

/** The loudest stretches (5-second average), at least `gap` seconds apart, in time order. */
export function loudPeaks(loud: number[], count = 15, gap = 30): { at: number; over: number }[] {
  if (loud.length < 3) return [];
  const median = [...loud].sort((a, b) => a - b)[Math.floor(loud.length / 2)];
  const avg = loud.map((_, i) => {
    const seg = loud.slice(Math.max(0, i - 2), i + 3);
    return seg.reduce((a, b) => a + b, 0) / seg.length;
  });
  const out: { at: number; over: number }[] = [];
  for (const i of avg.map((_, i) => i).sort((a, b) => avg[b] - avg[a])) {
    if (out.length >= count || avg[i] - median < 3) break;
    if (out.some((p) => Math.abs(p.at - i) < gap)) continue;
    out.push({ at: i, over: Math.round(avg[i] - median) });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** "[m:ss] words…" lines, broken at pauses, sentence ends and every ~12 seconds. */
export function transcriptLines(words: Heard[], from = 0, to = Infinity): string {
  const lines: string[] = [];
  let cur: Heard[] = [];
  const flush = () => {
    if (cur.length) lines.push(`[${clock(cur[0].start)}] ${cur.map((w) => w.text).join(' ')}`);
    cur = [];
  };
  for (const w of words) {
    if (w.start < from || w.start >= to) continue;
    const prev = cur.at(-1);
    if (cur.length && (w.start - cur[0].start > 12 || (prev && w.start - prev.end > 1.5))) flush();
    cur.push(w);
    if (/[.!?…]$/.test(w.text) && w.end - cur[0].start > 4) flush();
  }
  flush();
  return lines.join('\n');
}

function loudnessByMinute(loud: number[]): string {
  const lv = levels(loud);
  const lines: string[] = [];
  for (let m = 0; m * 60 < lv.length; m++) {
    const cells: number[] = [];
    for (let k = 0; k < 6; k++) {
      const seg = lv.slice(m * 60 + k * 10, m * 60 + k * 10 + 10);
      if (seg.length) cells.push(Math.max(...seg));
    }
    lines.push(`${clock(m * 60)}  ${cells.join(' ')}`);
  }
  return lines.join('\n');
}

/** Where to look closely at a candidate: a little before and after it, at most 150 seconds. */
export function windowFor(c: Candidate, duration: number): [number, number] {
  let from = Math.max(0, Math.min(c.start, c.end) - 8);
  let to = Math.min(duration, Math.max(c.start, c.end) + 8);
  if (to - from > 150) {
    const mid = (Math.min(c.start, c.end) + Math.max(c.start, c.end)) / 2;
    from = Math.max(0, mid - 75);
    to = Math.min(duration, from + 150);
  }
  return [from, Math.max(to, Math.min(duration, from + 5))];
}

const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/** Keeps the picks inside the video and the length limits, best score first, without two clips of the same moment. */
export function tidyPicks(raw: RawPick[], cands: Candidate[], duration: number, min: number, max: number, count: number): Pick[] {
  const out: Pick[] = [];
  for (const r of [...raw].sort((a, b) => b.score - a.score)) {
    let start = Math.max(0, Math.min(r.start, r.end, duration));
    let end = Math.min(duration, Math.max(r.start, r.end));
    if (end - start > max) end = start + max;
    if (end - start < min) {
      const mid = (start + end) / 2;
      start = Math.max(0, mid - min / 2);
      end = Math.min(duration, start + min);
      start = Math.max(0, end - min);
    }
    if (end - start < 3) continue;
    const span = { start, end };
    if (out.some((p) => overlap(p, span) > 0.5 * Math.min(p.end - p.start, end - start))) continue;
    out.push({
      start: Math.round(start * 10) / 10,
      end: Math.round(end * 10) / 10,
      score: Math.max(0, Math.min(100, Math.round(r.score))),
      title: (r.title.trim() || cands[r.candidate - 1]?.title || 'Klip').replace(/\s+/g, ' ').slice(0, 80),
      reason: r.reason.trim().replace(/\s+/g, ' ').slice(0, 600),
    });
    if (out.length >= count) break;
  }
  return out;
}

function briefText(b: Brief): string {
  return [
    `Channel style: ${b.style}`,
    b.wishes ? `What the owner wants in the clips: ${b.wishes}` : '',
    b.note ? `Owner's note about this video: ${b.note}` : '',
    b.lessons.length ? `What this channel's real results have shown so far:\n${b.lessons.map((l) => `- ${l}`).join('\n')}` : '',
    `Each short is ${b.minSeconds}-${b.maxSeconds} seconds long and shows one moment: how it builds up, the moment itself and the reaction. ` +
      'Prefer live play over studio talk, adverts, crowd-only shots and pre-match build-up, unless the owner asks for them.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

const image = async (file: string) => ({
  type: 'image' as const,
  source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: (await readFile(file)).toString('base64') },
});

export class ClipFinder {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
    baseURL?: string,
  ) {
    // Long multimodal requests: allow up to 20 minutes per call.
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 20 * 60_000, ...(baseURL ? { baseURL } : {}) });
  }

  private async ask<T extends z.ZodType>(system: string, content: Anthropic.Beta.BetaContentBlockParam[], schema: T): Promise<z.infer<T>> {
    let msg;
    try {
      msg = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 32000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system,
        messages: [{ role: 'user', content }],
        output_config: { effort: 'high', format: betaZodOutputFormat(schema) },
      });
    } catch (e) {
      throw claudeError(e, this.model);
    }
    if (msg.stop_reason === 'refusal') throw new Error('Claude bu videoyu incelemedi (içerik politikası)');
    if (msg.stop_reason === 'max_tokens') throw new Error('Claude’un cevabı yarıda kesildi; tekrar dene');
    if (!msg.parsed_output) throw new Error('Claude geçerli bir cevap döndürmedi; tekrar dene');
    return msg.parsed_output as z.infer<T>;
  }

  private system(language: string, stage: 1 | 2): string {
    const lang = LANGUAGES[language] ?? language;
    if (stage === 1) {
      return [
        'You are the clip editor of a YouTube Shorts channel. You go through a long video, usually football (soccer) match footage, and find the moments that would make the best vertical shorts.',
        'You cannot play the video. Instead you get contact sheets of stills taken every few seconds, each stamped with its time (minutes:seconds from the start) in its top-left corner; ' +
          'how loud the audio is over time (commentators and crowds get loud at big moments); and a transcript of what is said, with times, where sounds such as (cheering) are tagged.',
        'Use them together: a big moment usually shows as a loud stretch and excited commentary, and in the stills as the play itself followed by celebrations, close-ups or a replay.',
        'Give times as seconds from the start of the video.',
        `Write titles and reasons in ${lang}.`,
      ].join('\n');
    }
    return [
      'You are the clip editor of a YouTube Shorts channel. You went through a long video and listed candidate moments. ' +
        'Now you see each candidate up close: one still per second, each stamped with its time (minutes:seconds from the start of the video), with the transcript and loudness of that stretch.',
      'Pick the final clips and set exactly where each one starts and ends.',
      'Give times as seconds from the start of the video.',
      `Write titles and reasons in ${lang}.`,
    ].join('\n');
  }

  /** Stage 1: the whole video at a few seconds per still. */
  async candidates(o: { brief: Brief; duration: number; sheets: Sheet[]; loudness: number[]; words: Heard[]; count: number }): Promise<Candidate[]> {
    const per = Math.max(...o.sheets.map((s) => s.times.length));
    const content: Anthropic.Beta.BetaContentBlockParam[] = [
      {
        type: 'text',
        text:
          `${briefText(o.brief)}\n\nVideo length: ${clock(o.duration)}. ${o.sheets.length} contact sheet${o.sheets.length === 1 ? '' : 's'} of up to ${per} stills, ` +
          `about one still every ${overviewInterval(o.duration)} seconds or more, in reading order (left to right, top to bottom).`,
      },
    ];
    for (const [i, s] of o.sheets.entries()) {
      content.push({ type: 'text', text: `Sheet ${i + 1}: ${clock(s.times[0])}-${clock(s.times.at(-1) ?? s.times[0])}` });
      content.push(await image(s.file));
    }
    const peaks = loudPeaks(o.loudness);
    const transcript = transcriptLines(o.words);
    content.push({
      type: 'text',
      text: [
        o.loudness.length
          ? `Loudness from 0 (this video's usual level) to 9 (its loudest), the loudest second in each 10 seconds, one line per minute:\n${loudnessByMinute(o.loudness)}`
          : 'The video has no sound.',
        peaks.length ? `Loudest stretches: ${peaks.map((p) => `${clock(p.at)} (+${p.over} dB)`).join(', ')}` : '',
        o.loudness.length ? `Transcript:\n${transcript || '(nothing is said)'}` : '',
        `List up to ${o.count} candidate moments, best first. For each give start and end in seconds (a generous range around the moment is fine; ` +
          'you will look at it second by second next), a short working title, and why it stands out: what you saw and heard. Leave out moments that would make a weak short.',
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    const r = await this.ask(this.system(o.brief.language, 1), content, CandidatesSchema);
    return r.candidates
      .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && Math.max(c.start, c.end) > 0 && Math.min(c.start, c.end) < o.duration)
      .slice(0, o.count)
      .map((c) => ({ start: c.start, end: c.end, title: c.title.trim(), why: c.why.trim() }));
  }

  /** Stage 2: each candidate second by second; the final clips with exact times and a score. */
  async choose(o: { brief: Brief; duration: number; candidates: Candidate[]; windows: Window[]; loudness: number[]; words: Heard[]; count: number }): Promise<Pick[]> {
    const lv = levels(o.loudness);
    const content: Anthropic.Beta.BetaContentBlockParam[] = [{ type: 'text', text: briefText(o.brief) }];
    for (const [i, c] of o.candidates.entries()) {
      const w = o.windows[i];
      content.push({ type: 'text', text: `Candidate ${i + 1}: "${c.title}" (${clock(c.start)}-${clock(c.end)}). ${c.why}\nStills ${clock(w.from)}-${clock(w.to)}:` });
      for (const s of w.sheets) content.push(await image(s.file));
      const said = transcriptLines(o.words, w.from, w.to);
      const loud = lv.slice(Math.floor(w.from), Math.ceil(w.to));
      content.push({
        type: 'text',
        text: [
          said ? `Transcript of this stretch:\n${said}` : '',
          loud.length ? `Loudness per second (0-9) from ${clock(w.from)}: ${loud.join(' ')}` : '',
        ]
          .filter(Boolean)
          .join('\n') || '(no sound in this stretch)',
      });
    }
    content.push({
      type: 'text',
      text:
        `Pick up to ${o.count} clips, best first. For each give:\n` +
        '- candidate: its number;\n' +
        `- start and end in seconds: start just before the action begins (for a goal, include the move that leads to it) and end after the reaction or the first replay; ` +
        `${o.brief.minSeconds}-${o.brief.maxSeconds} seconds; cut where the picture changes when you can;\n` +
        '- score from 0 to 100 for how well it would do as a short on this channel: how strong the moment is, how clear it is on a phone screen, and how well it fits what the owner wants;\n' +
        '- a title of at most 60 characters and the reason, in one or two sentences.\n' +
        'Leave out candidates that turn out weak, unclear, or the same moment as another clip (for example its replay).',
    });
    const r = await this.ask(this.system(o.brief.language, 2), content, PicksSchema);
    return tidyPicks(r.clips, o.candidates, o.duration, o.brief.minSeconds, o.brief.maxSeconds, o.count);
  }
}

export interface FindJob {
  file: string;
  /** Work folder for the audio and the stills. */
  dir: string;
  fontFile: string;
  claude: { apiKey: string; model: string; baseURL?: string };
  eleven: { apiKey: string; base?: string };
  brief: Brief;
  /** How many final clips to pick. */
  count: number;
  step: (text: string) => void;
}

export interface Found {
  duration: number;
  language: string;
  words: Heard[];
  candidates: Candidate[];
  picks: Pick[];
}

export async function findClips(job: FindJob): Promise<Found> {
  const info = await probe(job.file);
  if (!info.duration) throw new Error('Video dosyası okunamadı');
  if (!info.width) throw new Error('Dosyada görüntü yok');
  await prepareWorkDir(job.dir, job.fontFile);

  let loudness: number[] = [];
  let words: Heard[] = [];
  let language = '';
  if (info.hasAudio) {
    job.step('Ses ayrılıyor');
    const a = await analyseAudio(job.file, job.dir);
    loudness = a.loudness;
    job.step('Konuşmalar yazıya dökülüyor (ElevenLabs)');
    ({ words, language } = await new ElevenClient(job.eleven.apiKey, job.eleven.base).transcribe(a.audio));
  }

  job.step('Videodan kareler alınıyor');
  const sheets = await overviewSheets(job.file, job.dir, info.duration);
  if (!sheets.length) throw new Error('Videodan kare alınamadı');

  const finder = new ClipFinder(job.claude.apiKey, job.claude.model, job.claude.baseURL);
  job.step('Claude videoyu izliyor');
  const candidates = await finder.candidates({
    brief: job.brief,
    duration: info.duration,
    sheets,
    loudness,
    words,
    count: Math.min(14, job.count * 2 + 4),
  });
  if (!candidates.length) return { duration: info.duration, language, words, candidates, picks: [] };

  job.step(`Claude ${candidates.length} aday ana yakından bakıyor`);
  const windows: Window[] = [];
  for (const [i, c] of candidates.entries()) {
    const [from, to] = windowFor(c, info.duration);
    windows.push({ from, to, sheets: await windowSheets(job.file, job.dir, `c${i + 1}`, from, to) });
  }
  const picks = await finder.choose({ brief: job.brief, duration: info.duration, candidates, windows, loudness, words, count: job.count });
  return { duration: info.duration, language, words, candidates, picks };
}
