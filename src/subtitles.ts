import type { Alignment } from './eleven';

export interface Word {
  text: string;
  start: number;
  end: number;
  /** The word closes a phrase (punctuation after it), so a caption should not run past it. */
  brk: boolean;
}

// Quotes, brackets and phrase punctuation around a word; ! and ? stay because they read as tone.
const EDGE = /^[\s"“”'‘’«»()[\].,;:…–—-]+|[\s"“”'‘’«»()[\].,;:…–—-]+$/g;

export function wordsFromAlignment(a: Alignment): Word[] {
  const words: Word[] = [];
  let raw = '';
  let start = -1;
  let end = 0;
  const flush = () => {
    // Double quotes never belong in a caption; apostrophes inside a word ("Icardi'nin") do.
    const text = raw.replace(/["“”«»{}\\]/g, '').replace(EDGE, '');
    if (text) words.push({ text, start, end, brk: /[.,;:!?…]["”’»)]*$/.test(raw) });
    raw = '';
    start = -1;
  };
  for (let i = 0; i < a.characters.length; i++) {
    const ch = a.characters[i];
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (start < 0) start = a.character_start_times_seconds[i];
    end = a.character_end_times_seconds[i];
    raw += ch;
  }
  flush();
  return words;
}

export function chunkWords(words: Word[], maxWords = 3, maxChars = 16): Word[][] {
  const chunks: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) {
    const prev = cur[cur.length - 1];
    const len = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
    if (prev && (cur.length >= maxWords || len > maxChars || prev.brk || w.start - prev.end > 0.6)) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  return `${Math.floor(cs / 360_000)}:${pad(Math.floor(cs / 6000) % 60)}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`;
}

/** #RRGGBB → the BBGGRR order ASS uses. */
const bgr = (hex: string) => `${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();

export const FONT_NAME = 'Montserrat ExtraBold';

/** Thumbnail text: big, centred, in the highlight colour with a heavy outline so it reads on any frame. */
export function buildCoverAss(text: string, highlight: string, locale: string): string {
  const t = text.replace(/[{}\\]/g, '').replace(/\s+/g, ' ').trim().toLocaleUpperCase(locale);
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Cover,${FONT_NAME},132,&H00${bgr(highlight)},&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,12,6,5,70,70,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    `Dialogue: 0,0:00:00.00,0:00:05.00,Cover,,0,0,0,,${t}`,
    '',
  ].join('\n');
}

export interface AssOptions {
  words: Word[];
  hook: string;
  /** 0 keeps the headline for the whole video. */
  hookSeconds: number;
  duration: number;
  position: 'lower' | 'middle';
  highlight: string;
  /** BCP 47 locale for upper-casing (Turkish needs its own i/İ rules). */
  locale: string;
}

export function buildAss(o: AssOptions): string {
  const upper = (s: string) => s.toLocaleUpperCase(o.locale);
  const hl = bgr(o.highlight);
  const [align, marginV] = o.position === 'middle' ? [5, 0] : [2, 560];
  const out = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Cap,${FONT_NAME},86,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,0,0,0,0,100,100,0,0,1,7,3,${align},80,80,${marginV},1`,
    // BorderStyle 3 draws an opaque box (in OutlineColour) behind the headline.
    `Style: Hook,${FONT_NAME},62,&H00111111,&H00111111,&H00FFFFFF,&H00000000,0,0,0,0,100,100,0,0,3,18,0,8,90,90,230,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const hook = upper(o.hook.replace(/[{}\\]/g, '').replace(/\s+/g, ' ').trim());
  if (hook) {
    const end = o.hookSeconds > 0 ? Math.min(o.hookSeconds, o.duration) : o.duration;
    out.push(`Dialogue: 1,${assTime(0)},${assTime(end)},Hook,,0,0,0,,${hook}`);
  }

  const chunks = chunkWords(o.words);
  chunks.forEach((chunk, ci) => {
    const next = chunks[ci + 1]?.[0]?.start;
    const last = chunk[chunk.length - 1];
    // Close small gaps so the captions do not flicker between phrases.
    let chunkEnd = last.end + 0.15;
    if (next !== undefined) chunkEnd = next - last.end <= 0.35 ? next : Math.min(chunkEnd, next);
    const texts = chunk.map((w) => upper(w.text));
    chunk.forEach((w, k) => {
      const end = Math.max(w.start + 0.04, k < chunk.length - 1 ? chunk[k + 1].start : chunkEnd);
      const line = texts.map((t, j) => (j === k ? `{\\c&H${hl}&\\fscx112\\fscy112}${t}{\\r}` : t)).join(' ');
      out.push(`Dialogue: 0,${assTime(w.start)},${assTime(end)},Cap,,0,0,0,,${line}`);
    });
  });
  return `${out.join('\n')}\n`;
}
