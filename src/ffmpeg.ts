import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

let configured = '';

export function setFfmpegPath(p: string): void {
  configured = p;
}

export function ffmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  if (configured) return configured;
  const local = join(process.cwd(), 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  return existsSync(local) ? local : 'ffmpeg';
}

const tail = (s: string) => s.trim().split(/\r?\n/).slice(-6).join(' | ');

function spawnFfmpeg(
  args: string[],
  cwd: string | undefined,
  timeoutMs: number,
  onLine?: (line: string) => void,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', ...args], { cwd, windowsHide: true });
    let stderr = '';
    let partial = '';
    p.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 400_000) stderr = stderr.slice(-200_000);
      if (onLine) {
        const lines = (partial + d).split(/\r?\n|\r/);
        partial = lines.pop() ?? '';
        lines.forEach(onLine);
      }
    });
    p.stdout.resume();
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT' ? `ffmpeg bulunamadı (${ffmpegPath()})` : e.message));
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (onLine && partial) onLine(partial);
      resolve({ code, stderr });
    });
  });
}

export async function runFfmpeg(args: string[], opts: { cwd?: string; timeoutMs?: number; onLine?: (line: string) => void } = {}): Promise<string> {
  const { code, stderr } = await spawnFfmpeg(args, opts.cwd, opts.timeoutMs ?? 20 * 60_000, opts.onLine);
  if (code !== 0) throw new Error(`ffmpeg hata verdi (${code}): ${tail(stderr)}`);
  return stderr;
}

export interface MediaInfo {
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export async function probe(file: string): Promise<MediaInfo> {
  // Without an output file ffmpeg exits with an error after printing the stream info, which is all we need.
  const { stderr } = await spawnFfmpeg(['-i', file], undefined, 60_000);
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!d) throw new Error(`Medya dosyası okunamadı: ${tail(stderr)}`);
  const v = /Stream #.*Video:.*?, (\d{2,5})x(\d{2,5})[\s,]/.exec(stderr);
  return {
    duration: Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]),
    width: v ? Number(v[1]) : 0,
    height: v ? Number(v[2]) : 0,
    hasAudio: /Stream #.*Audio:/.test(stderr),
  };
}

/** Where the stills are taken: the middle of each of `count` equal parts. */
export const frameTimes = (duration: number, count: number) => Array.from({ length: count }, (_, i) => (duration * (i + 0.5)) / count);

/** A few still frames spread across the clip, so Claude can see what happens in it. */
export async function extractFrames(input: string, outDir: string, count: number, duration: number): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const files: string[] = [];
  for (const [i, at] of frameTimes(duration, count).entries()) {
    const file = join(outDir, `frame${i + 1}.jpg`);
    await runFfmpeg(['-y', '-ss', at.toFixed(2), '-i', input, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', file], { timeoutMs: 60_000 });
    files.push(file);
  }
  return files;
}

/**
 * Length of the finished short: the narration plus a beat at the end. If the narration is longer than the clip,
 * the last frame is held; if it is much shorter, the clip is cut 3 seconds after it ends so the video does not drag.
 */
export function outputSeconds(clipSeconds: number, voiceSeconds: number): number {
  const needed = voiceSeconds + 0.8;
  return needed > clipSeconds ? needed : Math.min(clipSeconds, voiceSeconds + 3);
}

/** Wider than tall: shown whole in the middle of the vertical frame instead of filling it. */
export const isLandscape = (info: { width: number; height: number }) => info.width > info.height * 1.05;

/**
 * Filter steps that turn `input` into a 1080x1920 picture labelled `out`. A portrait clip fills the frame. A landscape
 * clip (match footage) sits in the middle over a blurred, darkened copy of itself, the usual look of football shorts;
 * `zoom` (0-50 %) trims that much of its width so the action is bigger.
 */
export function verticalFrame(input: string, out: string, landscape: boolean, zoom: number): string[] {
  if (!landscape) {
    return [`${input}scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1${out}`];
  }
  const keep = (1 - Math.min(50, Math.max(0, zoom)) / 100).toFixed(3);
  return [
    `${input}split=2[vbg][vfg]`,
    // Blurring a small copy and scaling it up looks the same as blurring the full frame and costs far less.
    '[vbg]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,gblur=sigma=10,scale=1080:1920,eq=brightness=-0.12:saturation=1.15[vbgb]',
    `[vfg]crop=trunc(iw*${keep}/2)*2:ih,scale=1080:-2:flags=lanczos[vfgs]`,
    `[vbgb][vfgs]overlay=(W-w)/2:(H-h)/2,setsar=1${out}`,
  ];
}

/** A 1080x1920 JPEG thumbnail: a clean frame of the clip (no captions) with the cover text from `subs` burned in. */
export async function renderCover(o: {
  cwd: string;
  clip: string;
  at: number;
  subs: string;
  fontsDir: string;
  out: string;
  landscape?: boolean;
  zoom?: number;
}): Promise<void> {
  const fonts = relative(o.cwd, o.fontsDir).split(sep).join('/') || '.';
  const graph = [...verticalFrame('[0:v]', '[f]', Boolean(o.landscape), o.zoom ?? 0), `[f]eq=contrast=1.08:saturation=1.25,ass=${o.subs}:fontsdir=${fonts}[v]`];
  await runFfmpeg(
    ['-y', '-ss', Math.max(0, o.at).toFixed(2), '-i', o.clip, '-filter_complex', graph.join(';'), '-map', '[v]', '-frames:v', '1', '-q:v', '3', o.out],
    { cwd: o.cwd, timeoutMs: 60_000 },
  );
}

export interface RenderOptions {
  /** Draft folder; the subtitle file and the output are relative to it. */
  cwd: string;
  clip: string;
  clipSeconds: number;
  clipHasAudio: boolean;
  voice: string;
  voiceSeconds: number;
  subs: string;
  fontsDir: string;
  music?: string;
  /** 0–1 */
  originalVolume: number;
  /** 0–1 */
  musicVolume: number;
  out: string;
  /** Wider than tall (match footage): placed in the middle over a blurred background. */
  landscape?: boolean;
  /** 0-50 % of a landscape clip's width trimmed away. */
  zoom?: number;
}

export async function renderShort(o: RenderOptions): Promise<number> {
  const total = outputSeconds(o.clipSeconds, o.voiceSeconds);
  const hold = total > o.clipSeconds ? `,tpad=stop_mode=clone:stop_duration=${(total - o.clipSeconds + 0.1).toFixed(2)}` : '';
  // Relative paths keep drive letters and spaces out of the filter string, which ffmpeg would need escaped.
  const fonts = relative(o.cwd, o.fontsDir).split(sep).join('/') || '.';
  const fmt = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';

  const args = ['-y', '-i', o.clip, '-i', o.voice];
  const useMusic = Boolean(o.music && o.musicVolume > 0);
  if (useMusic) args.push('-stream_loop', '-1', '-i', o.music as string);

  const graph = [
    ...verticalFrame('[0:v]', '[framed]', Boolean(o.landscape), o.zoom ?? 0),
    `[framed]fps=30${hold},ass=${o.subs}:fontsdir=${fonts}[v]`,
    `[1:a]${fmt}[vo]`,
  ];
  const mix = ['[vo]'];
  if (o.clipHasAudio && o.originalVolume > 0) {
    graph.push(`[0:a]${fmt},volume=${o.originalVolume.toFixed(2)}[orig]`);
    mix.push('[orig]');
  }
  if (useMusic) {
    graph.push(`[2:a]${fmt},volume=${o.musicVolume.toFixed(2)}[mus]`);
    mix.push('[mus]');
  }
  const mixed = mix.length > 1 ? `${mix.join('')}amix=inputs=${mix.length}:duration=longest:normalize=0,` : mix[0];
  graph.push(`${mixed}apad,atrim=0:${total.toFixed(2)},loudnorm=I=-14:TP=-1.5:LRA=11,${fmt}[a]`);

  args.push(
    '-filter_complex', graph.join(';'),
    '-map', '[v]', '-map', '[a]',
    '-t', total.toFixed(2),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart',
    o.out,
  );
  await runFfmpeg(args, { cwd: o.cwd });
  return total;
}
