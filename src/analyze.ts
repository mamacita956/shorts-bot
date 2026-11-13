import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runFfmpeg } from './ffmpeg';

/**
 * Turning a long video into what the clip agent can take in: its audio (for the transcript), how loud it is second by
 * second, and contact sheets of time-stamped stills. Everything is written under `dir`, which also holds a copy of the
 * font so ffmpeg filter arguments never contain a drive letter.
 */

export interface Sheet {
  file: string;
  /** Time of each still in reading order, seconds from the start of the video. */
  times: number[];
}

/** m:ss with the minutes running past 60 (92:05), the same as stamped on the stills. */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec + 1e-6));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const COLS = 5;
const ROWS = 4;
/** At most this many overview sheets (20 stills each) go to Claude. */
const MAX_SHEETS = 60;

/** Seconds between overview stills: at least 2, more for long videos so they fit in MAX_SHEETS. */
export const overviewInterval = (duration: number) => Math.max(2, Math.ceil(duration / (MAX_SHEETS * COLS * ROWS)));

export async function prepareWorkDir(dir: string, fontFile: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  if (!existsSync(join(dir, 'font.ttf'))) await copyFile(fontFile, join(dir, 'font.ttf'));
}

/** Pulls the first audio track out as small mono MP3 and measures its loudness once per second, in one pass. */
export async function analyseAudio(file: string, dir: string): Promise<{ audio: string; loudness: number[] }> {
  await runFfmpeg(
    [
      '-y', '-i', file, '-vn', '-sn', '-dn',
      '-filter_complex',
      '[0:a:0]aresample=16000,aformat=channel_layouts=mono,asplit=2[a][m];' +
        '[m]asetnsamples=n=16000:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=loud.txt,anullsink',
      '-map', '[a]', '-c:a', 'libmp3lame', '-b:a', '32k', 'audio.mp3',
    ],
    { cwd: dir, timeoutMs: 60 * 60_000 },
  );
  return { audio: join(dir, 'audio.mp3'), loudness: parseLoudness(await readFile(join(dir, 'loud.txt'), 'utf8')) };
}

/** RMS level in dB for every second; silence is -90. */
export function parseLoudness(text: string): number[] {
  const out: number[] = [];
  let t = -1;
  for (const line of text.split(/\r?\n/)) {
    const at = /pts_time:([\d.]+)/.exec(line);
    if (at) {
      t = Math.floor(Number(at[1]) + 1e-6);
      continue;
    }
    const v = /RMS_level=(\S+)/.exec(line);
    if (v && t >= 0) {
      const n = Number(v[1]);
      out[t] = Number.isFinite(n) ? Math.max(-90, n) : -90;
    }
  }
  return Array.from(out, (v) => v ?? -90);
}

const fitTile = (w: number, h: number) => `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;

/** Burns m:ss of each frame (its time plus `offset`) into the top-left corner. */
const stamp = (offset: number, size: number) =>
  `drawtext=fontfile=font.ttf:text='%{eif\\:floor((t+${offset})/60)\\:d}\\:%{eif\\:mod(t+${offset}\\,60)\\:d\\:2}'` +
  `:x=${Math.round(size / 4)}:y=${Math.round(size / 4)}:fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=${Math.round(size / 5)}`;

/** Runs a sheet-making ffmpeg command and collects the time of every frame that reached the sheets. */
async function sheets(args: string[], dir: string, prefix: string, perSheet: number, offset: number): Promise<Sheet[]> {
  const times: number[] = [];
  await runFfmpeg([...args, '-fps_mode', 'vfr', '-q:v', '4', `${prefix}%03d.jpg`], {
    cwd: dir,
    timeoutMs: 2 * 60 * 60_000,
    onLine: (line) => {
      const m = /showinfo.*\bn:\s*(\d+).*?\bpts_time:(-?[\d.]+)/.exec(line);
      if (m) times[Number(m[1])] = offset + Number(m[2]);
    },
  });
  const all = times.filter((t) => t !== undefined);
  const out: Sheet[] = [];
  for (let i = 0; i * perSheet < all.length; i++) {
    const file = join(dir, `${prefix}${String(i + 1).padStart(3, '0')}.jpg`);
    if (existsSync(file)) out.push({ file, times: all.slice(i * perSheet, (i + 1) * perSheet) });
  }
  return out;
}

/**
 * The whole video as contact sheets of 20 stills. Normally only key frames are decoded, which is many times faster
 * than decoding every frame; if the file has too few key frames for that, every frame is decoded instead.
 */
export async function overviewSheets(file: string, dir: string, duration: number): Promise<Sheet[]> {
  const every = overviewInterval(duration);
  const run = async (keyframesOnly: boolean) => {
    await rm(join(dir, 'overview'), { recursive: true, force: true });
    await mkdir(join(dir, 'overview'), { recursive: true });
    const pick = keyframesOnly ? `select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${every})'` : `fps=1/${every}`;
    return sheets(
      [
        '-y', ...(keyframesOnly ? ['-skip_frame', 'nokey'] : []), '-i', file, '-an', '-sn', '-dn',
        '-vf', `setpts=PTS-STARTPTS,${pick},showinfo,${fitTile(320, 180)},${stamp(0, 24)},tile=${COLS}x${ROWS}`,
      ],
      dir,
      'overview/sheet',
      COLS * ROWS,
      0,
    );
  };
  let out = await run(true);
  const stills = out.reduce((n, s) => n + s.times.length, 0);
  if (stills < Math.max(2, duration / (every * 4))) out = await run(false);
  return out;
}

/** One still per second (two for long windows) from `from` to `to`, 30 to a sheet. */
export async function windowSheets(file: string, dir: string, name: string, from: number, to: number): Promise<Sheet[]> {
  const len = Math.max(1, to - from);
  const step = len > 100 ? 2 : 1;
  await mkdir(join(dir, 'windows'), { recursive: true });
  return sheets(
    [
      '-y', '-ss', from.toFixed(2), '-t', len.toFixed(2), '-i', file, '-an', '-sn', '-dn',
      '-vf', `fps=1/${step},showinfo,${fitTile(256, 144)},${stamp(from, 20)},tile=6x5`,
    ],
    dir,
    `windows/${name}_`,
    30,
    from,
  );
}

/** Cuts [start, end] out of the source as an H.264 clip (at most 1920 wide), keeping its shape; the short is framed later. */
export async function cutClip(file: string, start: number, end: number, out: string): Promise<void> {
  await mkdir(dirname(out), { recursive: true });
  const tmp = `${out}.tmp.mp4`;
  await runFfmpeg(
    [
      '-y', '-ss', start.toFixed(2), '-t', (end - start).toFixed(2), '-i', file,
      '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
      '-vf', "yadif=deint=interlaced,scale='min(1920,iw)':-2",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-movflags', '+faststart', tmp,
    ],
    { timeoutMs: 30 * 60_000 },
  );
  await rename(tmp, out);
}
