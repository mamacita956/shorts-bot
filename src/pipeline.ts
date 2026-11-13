import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { ScriptWriter } from './claude';
import { ElevenClient, type Alignment } from './eleven';
import { cutClip } from './analyze';
import { extractFrames, frameTimes, isLandscape, outputSeconds, probe, renderCover, renderShort } from './ffmpeg';
import { findClips } from './finder';
import { download } from './http';
import { firstSentence, type Result } from './insights';
import { log } from './log';
import { OpusClient } from './opus';
import { safeName, type Paths } from './paths';
import { ReviewPanel, type Review } from './review';
import { nextSlot } from './schedule';
import { CLIP_BUCKETS, type Settings } from './settings';
import type { Clip, Draft, Source, Store } from './store';
import { buildAss, buildCoverAss, wordsFromAlignment } from './subtitles';
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

/**
 * Makes sure the clip is on disk. Clips from a video file are cut from it again; OpusClip clips are downloaded, and if
 * the stored link has expired, OpusClip is asked for fresh links.
 */
async function ensureClip(ctx: Ctx, clip: Clip): Promise<string> {
  const file = clipFile(ctx, clip);
  if (existsSync(file) && statSync(file).size > 0) return file;
  const src = ctx.store.data.sources.find((x) => x.id === clip.sourceId);
  if (src?.kind === 'file') {
    if (!src.file || !existsSync(src.file)) throw new Error(`Klibin alındığı video dosyası bulunamadı: ${src.file ?? ''}`);
    await cutClip(src.file, clip.startSec ?? 0, clip.endSec ?? clip.durationMs / 1000, file);
    return file;
  }
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
    const memory = channelMemory(ctx);
    const script = await new ScriptWriter(s.anthropicApiKey, s.claudeModel, ctx.endpoints.claude).write({
      language: s.language,
      style: s.channelStyle,
      seconds: info.duration,
      clip: { title: clip.title, description: clip.description, hashtags: clip.hashtags, text: clip.text, keywords: clip.keywords },
      sourceNote: source?.note ?? '',
      instructions: d.instructions,
      previous: d.mode === 'rewrite' && d.narration ? { hook: d.hook, narration: d.narration } : undefined,
      feedback: d.mode === 'rewrite' && d.review?.verdict === 'reject' ? d.review.feedback : undefined,
      lessons: memory.lessons,
      examples: memory.examples,
      frames: await Promise.all(frames.map((f) => readFile(f))),
    });
    const { coverFrame, ...text } = script;
    ctx.store.updateDraft(d, { ...text, coverAt: frameTimes(info.duration, frames.length)[coverFrame - 1] });
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
      landscape: isLandscape(info),
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
    landscape: isLandscape(info),
    zoom: s.landscapeZoom,
  });
  // Renamed only when complete, so the panel never plays a half-written file.
  await rename(join(dir, 'final.tmp.mp4'), join(dir, 'final.mp4'));
  const out = await probe(join(dir, 'final.mp4'));

  if (s.coverEnabled) {
    step('Kapak hazırlanıyor');
    await renderCoverFor(ctx, d, info.duration);
  }
  ctx.store.updateDraft(d, {
    status: 'ready',
    step: undefined,
    hasVideo: true,
    hasCover: s.coverEnabled,
    clipSeconds: info.duration,
    voiceSeconds,
    videoSeconds: out.duration,
  });
}

/** The cover: a clean frame of the clip (no captions) with the cover text. Also redrawn alone when only that text is edited. */
export async function renderCoverFor(ctx: Ctx, d: Draft, clipSeconds = d.clipSeconds ?? 0): Promise<void> {
  const s = ctx.settings();
  const dir = draftDir(ctx, d);
  const clipPath = await ensureClip(ctx, ctx.store.clip(d.clipKey));
  const info = await probe(clipPath);
  await writeFile(join(dir, 'cover.ass'), buildCoverAss(d.coverText || d.hook, s.highlightColor, s.language));
  await renderCover({
    cwd: dir,
    clip: clipPath,
    at: d.coverAt ?? clipSeconds * 0.3,
    subs: 'cover.ass',
    fontsDir: ctx.paths.fontsDir,
    out: 'cover.tmp.jpg',
    landscape: isLandscape(info),
    zoom: s.landscapeZoom,
  });
  await rename(join(dir, 'cover.tmp.jpg'), join(dir, 'cover.jpg'));
}

/** Shortest and longest clip the settings allow (OpusClip's duration buckets, used by the clip agent too). */
export function clipLengths(s: Settings): [number, number] {
  const spans = s.opusClipBuckets.map((b) => CLIP_BUCKETS[b]).filter(Boolean);
  const min = Math.max(10, Math.min(...spans.map((x) => x[0])));
  const max = Math.max(min + 10, ...spans.map((x) => x[1]));
  return [min, Math.min(max, 180)];
}

/**
 * The clip agent's whole job for a video file: Claude watches it and picks the moments, then each one is cut out.
 * Returns the clips, best first, ready to be stored.
 */
export async function analyseSource(ctx: Ctx, src: Source, step: (text: string) => void): Promise<Clip[]> {
  const s = ctx.settings();
  if (!s.anthropicApiKey) throw new Error('Claude API anahtarı yok (Ayarlar → Claude)');
  if (!s.elevenApiKey) throw new Error('ElevenLabs API anahtarı yok (Ayarlar → ElevenLabs); konuşmaları yazıya dökmek için gerekli');
  if (!src.file || !existsSync(src.file)) throw new Error(`Video dosyası bulunamadı: ${src.file ?? ''}`);
  const [minSeconds, maxSeconds] = clipLengths(s);
  const work = join(ctx.paths.home, 'media', 'analysis', src.id);
  const found = await findClips({
    file: src.file,
    dir: work,
    fontFile: join(ctx.paths.fontsDir, 'Montserrat-ExtraBold.ttf'),
    claude: { apiKey: s.anthropicApiKey, model: s.claudeModel, baseURL: ctx.endpoints.claude },
    eleven: { apiKey: s.elevenApiKey, base: ctx.endpoints.eleven },
    brief: {
      language: s.language,
      style: s.channelStyle,
      wishes: s.clipWishes,
      note: src.note,
      lessons: ctx.store.data.insights?.lessons ?? [],
      minSeconds,
      maxSeconds,
    },
    count: s.opusTopN + 2,
    step,
  });
  if (!found.picks.length) throw new Error('Claude bu videoda kısa video olacak bir an bulamadı');
  const clips: Clip[] = [];
  for (const [i, p] of found.picks.entries()) {
    step(`Klipler kesiliyor (${i + 1}/${found.picks.length})`);
    const clip: Clip = {
      key: `${src.id}.m${i + 1}`,
      sourceId: src.id,
      projectId: '',
      curationId: `m${i + 1}`,
      rank: i + 1,
      title: p.title,
      description: p.reason,
      hashtags: '',
      text: found.words.filter((w) => !w.event && w.start >= p.start && w.start < p.end).map((w) => w.text).join(' '),
      durationMs: Math.round((p.end - p.start) * 1000),
      keywords: [],
      previewUrl: '',
      exportUrl: '',
      status: 'new',
      createdAt: new Date().toISOString(),
      score: p.score,
      startSec: p.start,
      endSec: p.end,
    };
    await cutClip(src.file, p.start, p.end, clipFile(ctx, clip));
    clips.push(clip);
  }
  // The audio and the stills are only needed while Claude watches; keep what it decided, for reference.
  await writeFile(join(work, 'result.json'), JSON.stringify({ language: found.language, candidates: found.candidates, picks: found.picks }, null, 2));
  for (const f of ['audio.mp3', 'loud.txt', 'font.ttf']) await rm(join(work, f), { force: true });
  for (const d of ['overview', 'windows']) await rm(join(work, d), { recursive: true, force: true });
  return clips;
}

/** Published shorts with their latest numbers, newest first. */
export function results(ctx: Ctx, now = Date.now()): (Result & { draftId: string; youtubeId: string })[] {
  const ranks = new Map(ctx.store.data.clips.map((c) => [c.key, c.rank]));
  return ctx.store.data.drafts
    .filter((d) => d.youtubeId && d.slot && d.stats && Date.parse(d.slot) <= now)
    .map((d) => ({
      draftId: d.id,
      youtubeId: d.youtubeId as string,
      title: d.title,
      hook: d.hook,
      opening: firstSentence(d.narration),
      seconds: d.videoSeconds ?? 0,
      opusRank: ranks.get(d.clipKey) ?? 0,
      panelScore: d.review?.score,
      views: d.stats?.views ?? 0,
      likes: d.stats?.likes ?? 0,
      comments: d.stats?.comments ?? 0,
      hoursLive: (now - Date.parse(d.slot as string)) / 3_600_000,
      earlyViews: d.early?.views,
      publishedAt: d.slot as string,
    }))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

/** What the channel has learned so far, for the script writer and the review panel. */
export function channelMemory(ctx: Ctx) {
  const rows = results(ctx);
  const best = rows
    .filter((r) => r.hoursLive >= 24)
    .sort((a, b) => (b.earlyViews ?? b.views) - (a.earlyViews ?? a.views))
    .slice(0, 3);
  return {
    lessons: ctx.store.data.insights?.lessons ?? [],
    // A single result says little; examples and the track record start with a few.
    examples: rows.length >= 3 ? best.map((r) => ({ hook: r.hook, opening: r.opening, views: r.earlyViews ?? r.views })) : [],
    track:
      rows.length >= 2
        ? rows.slice(0, 8).map((r) => ({ title: r.title, panelScore: r.panelScore, views: r.views, earlyViews: r.earlyViews, hoursLive: r.hoursLive }))
        : [],
  };
}

/** Sets the cover on YouTube once the video has finished processing; false means "not yet, try later". */
export async function setThumbnailFor(ctx: Ctx, d: Draft): Promise<boolean> {
  const state = await ctx.youtube.processingStatus(d.youtubeId as string);
  if (state === 'failed' || state === 'terminated') throw new Error('YouTube videoyu işleyemedi; kapak yüklenmedi');
  if (state !== 'succeeded') return false;
  await ctx.youtube.setThumbnail(d.youtubeId as string, join(draftDir(ctx, d), 'cover.jpg'));
  return true;
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
  const memory = channelMemory(ctx);
  return new ReviewPanel(s.anthropicApiKey, s.claudeModel, ctx.endpoints.claude).review({
    language: s.language,
    style: s.channelStyle,
    frames: await Promise.all(frames.map((f) => readFile(f))),
    draft: { hook: d.hook, narration: d.narration, title: d.title, description: d.description, tags: d.tags, coverText: d.hasCover ? d.coverText : undefined },
    clip: { rank: clip.rank, seconds: clip.durationMs / 1000, text: clip.text },
    videoSeconds: info.duration,
    sourceNote: source?.note ?? '',
    minScore: s.reviewMinScore,
    lessons: memory.lessons,
    track: memory.track,
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
