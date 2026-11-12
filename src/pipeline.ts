import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { ScriptWriter } from './claude';
import { ElevenClient, type Alignment } from './eleven';
import { extractFrames, outputSeconds, probe, renderShort } from './ffmpeg';
import { download } from './http';
import { log } from './log';
import { OpusClient } from './opus';
import { safeName, type Paths } from './paths';
import { ReviewPanel, type Review } from './review';
import { nextSlot } from './schedule';
import type { Settings } from './settings';
import type { Clip, Draft, Store } from './store';
import { buildAss, wordsFromAlignment } from './subtitles';
import type { YouTube } from './youtube';

export interface Endpoints {
  opus: string;
  eleven: string;
  /** Claude API base URL; undefined means the SDK default. */
  claude?: string;
}

export interface Ctx {
  store: Store;
  paths: Paths;
  settings: () => Settings;
  endpoints: Endpoints;
  youtube: YouTube;
}

export const draftDir = (ctx: Ctx, d: Draft) => join(ctx.paths.draftsDir, d.id);
export const clipFile = (ctx: Ctx, c: Clip) => join(ctx.paths.clipsDir, `${safeName(c.key)}.mp4`);

const MUSIC_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac']);

function pickMusic(dir: string): string | undefined {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => MUSIC_EXT.has(extname(f).toLowerCase()));
  } catch {
    return undefined;
  }
  return files.length ? join(dir, files[Math.floor(Math.random() * files.length)]) : undefined;
}

/** Downloads the clip once; if the stored link has expired, asks OpusClip for fresh links and tries again. */
async function ensureClip(ctx: Ctx, clip: Clip): Promise<string> {
  const file = clipFile(ctx, clip);
  if (existsSync(file) && statSync(file).size > 0) return file;
  const tryUrls = async () => {
    let last: unknown;
    for (const url of [clip.exportUrl, clip.previewUrl].filter(Boolean)) {
      try {
        await download('OpusClip', url, file);
        return true;
      } catch (e) {
        last = e;
      }
    }
    if (last) log.warn(`Klip indirilemedi (${(last as Error).message}); bağlantı yenileniyor`);
    return false;
  };
  if (await tryUrls()) return file;
  const s = ctx.settings();
  const items = await new OpusClient(s.opusApiKey, s.opusOrgId, ctx.endpoints.opus).listClips(clip.projectId);
  const fresh = items.find((i) => i.id === clip.key);
  if (!fresh) throw new Error('Klip OpusClip’te artık yok (projeler 30 gün sonra silinir)');
  clip.exportUrl = fresh.uriForExport ?? '';
  clip.previewUrl = fresh.uriForPreview ?? '';
  ctx.store.save();
  if (await tryUrls()) return file;
  throw new Error('Klip videosu OpusClip’ten indirilemedi');
}

export async function prepareDraft(ctx: Ctx, d: Draft): Promise<void> {
  const s = ctx.settings();
  const clip = ctx.store.clip(d.clipKey);
  const source = ctx.store.data.sources.find((x) => x.id === clip.sourceId);
  const dir = draftDir(ctx, d);
  await mkdir(dir, { recursive: true });
  const step = (name: string) => ctx.store.updateDraft(d, { status: 'preparing', step: name, error: undefined });

  step('Klip indiriliyor');
  const clipPath = await ensureClip(ctx, clip);
  const info = await probe(clipPath);

  if (d.mode === 'full' || d.mode === 'rewrite' || !d.narration) {
    if (!s.anthropicApiKey) throw new Error('Claude API anahtarı yok (Ayarlar → Claude)');
    step('Claude metni yazıyor');
    const frames = await extractFrames(clipPath, join(dir, 'frames'), 4, info.duration);
    const script = await new ScriptWriter(s.anthropicApiKey, s.claudeModel, ctx.endpoints.claude).write({
      language: s.language,
      style: s.channelStyle,
      seconds: info.duration,
      clip: { title: clip.title, description: clip.description, hashtags: clip.hashtags, text: clip.text, keywords: clip.keywords },
      sourceNote: source?.note ?? '',
      instructions: d.instructions,
      previous: d.mode === 'rewrite' && d.narration ? { hook: d.hook, narration: d.narration } : undefined,
      feedback: d.mode === 'rewrite' && d.review?.verdict === 'reject' ? d.review.feedback : undefined,
      frames: await Promise.all(frames.map((f) => readFile(f))),
    });
    ctx.store.updateDraft(d, script);
  }

  const voicePath = join(dir, 'voice.mp3');
  const alignPath = join(dir, 'alignment.json');
  if (d.mode === 'revoice' || d.voicedNarration !== d.narration || !existsSync(voicePath) || !existsSync(alignPath)) {
    if (!s.elevenApiKey) throw new Error('ElevenLabs API anahtarı yok (Ayarlar → ElevenLabs)');
    if (!s.voiceId) throw new Error('Seslendirme sesi seçilmedi (Ayarlar → ElevenLabs → Ses)');
    step('Seslendirme hazırlanıyor');
    const { audio, alignment } = await new ElevenClient(s.elevenApiKey, ctx.endpoints.eleven).speak({
      voiceId: s.voiceId,
      text: d.narration,
      modelId: s.elevenModel,
      language: s.language,
      speed: s.voiceSpeed,
      stability: s.voiceStability,
    });
    await writeFile(voicePath, audio);
    await writeFile(alignPath, JSON.stringify(alignment));
    ctx.store.updateDraft(d, {
      voicedNarration: d.narration,
      voiceSeconds: Math.max(0, ...alignment.character_end_times_seconds),
    });
  }

  step('Video hazırlanıyor');
  const alignment = JSON.parse(await readFile(alignPath, 'utf8')) as Alignment;
  const voiceSeconds = d.voiceSeconds ?? Math.max(0, ...alignment.character_end_times_seconds);
  const total = outputSeconds(info.duration, voiceSeconds);
  await writeFile(
    join(dir, 'subs.ass'),
    buildAss({
      words: wordsFromAlignment(alignment),
      hook: d.hook,
      hookSeconds: s.hookSeconds,
      duration: total,
      position: s.captionPosition,
      highlight: s.highlightColor,
      locale: s.language,
    }),
  );
  await rm(join(dir, 'final.tmp.mp4'), { force: true });
  await renderShort({
    cwd: dir,
    clip: clipPath,
    clipSeconds: info.duration,
    clipHasAudio: info.hasAudio,
    voice: voicePath,
    voiceSeconds,
    subs: 'subs.ass',
    fontsDir: ctx.paths.fontsDir,
    music: pickMusic(ctx.paths.musicDir),
    originalVolume: s.originalVolume / 100,
    musicVolume: s.musicVolume / 100,
    out: 'final.tmp.mp4',
  });
  // Renamed only when complete, so the panel never plays a half-written file.
  await rename(join(dir, 'final.tmp.mp4'), join(dir, 'final.mp4'));
  const out = await probe(join(dir, 'final.mp4'));
  ctx.store.updateDraft(d, {
    status: 'ready',
    step: undefined,
    hasVideo: true,
    clipSeconds: info.duration,
    voiceSeconds,
    videoSeconds: out.duration,
  });
}

/** The review panel looks at the finished video as viewers will see it: stills with the headline and captions burned in. */
export async function reviewDraft(ctx: Ctx, d: Draft): Promise<Review> {
  const s = ctx.settings();
  if (!s.anthropicApiKey) throw new Error('Claude API anahtarı yok (Ayarlar → Claude)');
  const dir = draftDir(ctx, d);
  const video = join(dir, 'final.mp4');
  const info = await probe(video);
  const frames = await extractFrames(video, join(dir, 'review'), 4, info.duration);
  const clip = ctx.store.clip(d.clipKey);
  const source = ctx.store.data.sources.find((x) => x.id === clip.sourceId);
  return new ReviewPanel(s.anthropicApiKey, s.claudeModel, ctx.endpoints.claude).review({
    language: s.language,
    style: s.channelStyle,
    frames: await Promise.all(frames.map((f) => readFile(f))),
    draft: { hook: d.hook, narration: d.narration, title: d.title, description: d.description, tags: d.tags },
    clip: { rank: clip.rank, seconds: clip.durationMs / 1000, text: clip.text },
    videoSeconds: info.duration,
    sourceNote: source?.note ?? '',
    minScore: s.reviewMinScore,
  });
}

/** The publish time for the next approved video, after every slot already booked. */
export function slotAfterBooked(ctx: Ctx, except?: Draft, now = new Date()): Date {
  const s = ctx.settings();
  const booked = ctx.store.data.drafts
    .filter((x) => x !== except && x.slot && ['approved', 'uploading', 'scheduled'].includes(x.status))
    .map((x) => new Date(x.slot as string).getTime());
  const last = booked.length ? new Date(Math.max(...booked)) : undefined;
  return nextSlot({ now, lastSlot: last, intervalDays: s.intervalDays, time: s.publishTime });
}

export async function uploadDraft(ctx: Ctx, d: Draft): Promise<void> {
  const s = ctx.settings();
  const file = join(draftDir(ctx, d), 'final.mp4');
  if (!existsSync(file)) throw new Error('Video dosyası bulunamadı; taslağı yeniden oluştur');
  // A slot that went by while the app was closed would publish at once and break the spacing.
  if (!d.slot || new Date(d.slot).getTime() < Date.now() + 10 * 60_000) {
    ctx.store.updateDraft(d, { slot: slotAfterBooked(ctx, d).toISOString() });
  }
  ctx.store.updateDraft(d, { status: 'uploading', error: undefined });
  const youtubeId = await ctx.youtube.upload(file, {
    title: d.title,
    description: [d.description, s.descriptionFooter].filter((x) => x.trim()).join('\n\n'),
    tags: d.tags,
    categoryId: s.categoryId,
    language: s.language,
    publishAt: d.slot,
    madeForKids: s.madeForKids,
    syntheticMedia: s.syntheticMedia,
  });
  ctx.store.updateDraft(d, { status: 'scheduled', youtubeId, uploadAttempts: 0, nextAttemptAt: undefined });
}
