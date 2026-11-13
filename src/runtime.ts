import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ElevenClient, type Voice } from './eleven';
import { runFfmpeg } from './ffmpeg';
import { log } from './log';
import { OPUS_STAGE_NAMES, OpusBusyError, OpusClient, type OpusClipItem } from './opus';
import { pathsFor, safeName, type Paths } from './paths';
import { LessonWriter, type Insights } from './insights';
import { clipFile, prepareDraft, renderCoverFor, results, reviewDraft, setThumbnailFor, slotAfterBooked, uploadDraft, type Ctx, type Endpoints } from './pipeline';
import { applySettingsInput, loadSettings, settingsView, writeSettings, type Settings } from './settings';
import { newId, Store, type Clip, type Draft, type DraftStatus, type PrepareMode, type Source } from './store';
import { fitTags, GOOGLE, ThumbnailForbiddenError, YouTube, type GoogleEndpoints } from './youtube';
import { ScriptWriter, targetWords } from './claude';

export interface RuntimeOptions {
  home: string;
  /** Folder that ships with the app and holds fonts/. */
  assetsDir: string;
  endpoints?: Partial<Endpoints>;
  google?: GoogleEndpoints;
  tickMs?: number;
  opusPollMs?: number;
  uploadRetryDelayMs?: number;
  /** Shows a desktop notification (desktop app only). */
  notify?: (title: string, body: string) => void;
  /** Called after settings were saved, e.g. to apply "start with Windows". */
  onSettingsSaved?: (s: Settings) => void;
}

/** Drafts that count toward the "ready drafts" buffer. Failed ones count too, so a broken key cannot burn through every clip. */
const IN_BUFFER: DraftStatus[] = ['queued', 'preparing', 'reviewing', 'ready', 'failed'];
/** In agents mode, drafts still on their way to a decision. Ready ones wait for the owner and do not hold up the next clip. */
const IN_PIPELINE: DraftStatus[] = ['queued', 'preparing', 'reviewing', 'failed'];
const BOOKED: DraftStatus[] = ['approved', 'uploading', 'scheduled'];
const EDITABLE: DraftStatus[] = ['ready', 'failed'];

/** How often YouTube's public counts are fetched for published shorts. */
const STATS_EVERY_MS = 6 * 3_600_000;
/** Lessons are first written once this many shorts have results. */
const LESSONS_MIN_RESULTS = 3;
const REJECTION: Record<string, string> = {
  copyright: 'telif hakkı',
  claim: 'hak talebi',
  duplicate: 'aynı video daha önce yüklenmiş',
  inappropriate: 'uygunsuz içerik',
  termsOfUse: 'kullanım şartları',
  trademark: 'marka hakkı',
  legal: 'yasal sebep',
  length: 'video uzunluğu',
};

const iso = () => new Date().toISOString();
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const due = (at?: string) => !at || Date.parse(at) <= Date.now();
const msg = (e: unknown) => (e as Error).message;
const when = (t?: string) => (t ? new Date(t).toLocaleString('tr-TR', { day: '2-digit', month: 'long', weekday: 'long', hour: '2-digit', minute: '2-digit' }) : '');

export interface SetupIssue {
  text: string;
  section: string;
}

export class Runtime {
  readonly paths: Paths;
  readonly store: Store;
  readonly youtube: YouTube;
  readonly ctx: Ctx;
  settings: Settings;
  ffmpegError?: string;
  private queue: { key: string; label: string; run: () => Promise<void> }[] = [];
  private keys = new Set<string>();
  private busy?: string;
  private pumping?: Promise<void>;
  private ticking?: Promise<void>;
  private tickAgain = false;
  private timer?: NodeJS.Timeout;

  constructor(private readonly o: RuntimeOptions) {
    this.paths = pathsFor(o.home);
    this.settings = loadSettings(this.paths.settingsFile);
    this.store = new Store(this.paths.storeFile);
    this.youtube = new YouTube(
      this.paths.tokenFile,
      () => ({ clientId: this.settings.googleClientId, clientSecret: this.settings.googleClientSecret }),
      o.google ?? GOOGLE,
      o.uploadRetryDelayMs,
    );
    this.ctx = {
      store: this.store,
      paths: this.paths,
      settings: () => this.settings,
      endpoints: { opus: 'https://api.opus.pro', eleven: 'https://api.elevenlabs.io', ...o.endpoints },
      youtube: this.youtube,
    };
    for (const dir of [this.paths.clipsDir, this.paths.draftsDir, this.paths.musicDir, this.paths.fontsDir]) mkdirSync(dir, { recursive: true });
    this.installFonts();
  }

  /** The ffmpeg subtitle filter reads fonts from a folder next to the data, so the bundled ones are copied there. */
  private installFonts() {
    const src = join(this.o.assetsDir, 'fonts');
    for (const f of readdirSync(src).filter((x) => /\.(ttf|otf)$/i.test(x))) {
      const dest = join(this.paths.fontsDir, f);
      if (!existsSync(dest) || statSync(dest).size !== statSync(join(src, f)).size) copyFileSync(join(src, f), dest);
    }
  }

  async start(): Promise<void> {
    try {
      await runFfmpeg(['-version'], { timeoutMs: 20_000 });
    } catch (e) {
      this.ffmpegError = msg(e);
      log.error(`ffmpeg çalışmıyor, video hazırlanamaz: ${this.ffmpegError}`);
    }
    // Work cut off by a restart starts over.
    for (const d of this.store.data.drafts) {
      if (d.status === 'preparing') d.status = 'queued';
      if (d.status === 'uploading') d.status = 'approved';
    }
    this.store.save();
    for (const d of this.store.data.drafts) {
      if (d.status === 'queued') this.enqueuePrepare(d);
      if (d.status === 'reviewing') this.enqueueReview(d);
    }
    this.timer = setInterval(() => void this.tick(), this.o.tickMs ?? 60_000);
    void this.tick();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  // ---------- job queue: one heavy job (render, upload) at a time ----------

  private enqueue(key: string, label: string, run: () => Promise<void>) {
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.queue.push({ key, label, run });
    if (!this.pumping) this.pumping = this.pump().finally(() => (this.pumping = undefined));
  }

  private async pump() {
    for (let job = this.queue.shift(); job; job = this.queue.shift()) {
      this.busy = job.label;
      try {
        await job.run();
      } catch (e) {
        log.error(`${job.label}: ${msg(e)}`);
      } finally {
        this.keys.delete(job.key);
        this.busy = undefined;
      }
    }
  }

  /** Resolves once no tick or job is running (used by tests). */
  async idle(): Promise<void> {
    while (this.pumping || this.ticking) {
      await this.ticking;
      await this.pumping;
    }
  }

  private notify(title: string, body: string) {
    try {
      this.o.notify?.(title, body);
    } catch {
      // A notification that cannot be shown must not stop the work.
    }
  }

  private enqueuePrepare(d: Draft) {
    this.enqueue(`prepare:${d.id}`, `Taslak hazırlanıyor: ${d.title || d.id}`, async () => {
      if (d.status !== 'queued') return;
      try {
        await prepareDraft(this.ctx, d);
      } catch (e) {
        this.store.updateDraft(d, { status: 'failed', step: undefined, error: msg(e) });
        log.error(`Taslak hazırlanamadı (${d.title || d.id}): ${msg(e)}`);
        this.notify('Taslak hazırlanamadı', `${d.title || 'Taslak'}: ${msg(e)}`);
        return;
      }
      if (this.settings.reviewMode === 'off') {
        log.ok(`Taslak hazır, onayını bekliyor: ${d.title}`);
        this.notify('Taslak onay bekliyor', d.title);
        return;
      }
      this.store.updateDraft(d, { status: 'reviewing' });
      this.enqueueReview(d);
    });
  }

  private enqueueReview(d: Draft) {
    this.enqueue(`review:${d.id}`, `Ajanlar değerlendiriyor: ${d.title}`, async () => {
      if (d.status !== 'reviewing') return;
      let review;
      try {
        review = await reviewDraft(this.ctx, d);
      } catch (e) {
        // Without a verdict nothing goes out on its own; the owner decides.
        this.store.updateDraft(d, { status: 'ready', error: `Ajanlar değerlendiremedi: ${msg(e)}` });
        log.error(`Ajan değerlendirmesi yapılamadı (${d.title}): ${msg(e)}`);
        this.notify('Taslak onay bekliyor', `Ajanlar değerlendiremedi: ${d.title}`);
        return;
      }
      this.store.updateDraft(d, { review, status: 'ready', error: undefined });
      this.afterReview(d);
    });
  }

  /** Acts on the panel's verdict: publish, rewrite with its feedback, or hand over to the owner. */
  private afterReview(d: Draft) {
    const r = d.review;
    if (!r) return;
    const tally = `${r.approvals}/3 onay, ortalama ${r.score}/10`;
    const agents = this.settings.reviewMode === 'agents';
    if (r.verdict === 'approve') {
      if (agents && this.youtube.status().connected) {
        const slot = this.approveDraft(d.id);
        log.ok(`Ajanlar onayladı (${tally}), ${when(slot)} yayınlanacak: ${d.title}`);
        this.notify('Ajanlar onayladı', `${d.title} · ${when(slot)} yayınlanacak`);
      } else {
        log.ok(`Ajanlar onayladı (${tally}), onayını bekliyor: ${d.title}`);
        this.notify('Taslak onay bekliyor', `Ajanlar onayladı: ${d.title}`);
      }
      return;
    }
    if (agents && (d.revisions ?? 0) < this.settings.reviewRevisions) {
      log.info(`Ajanlar reddetti (${tally}); metin onların geri bildirimiyle yeniden yazılıyor: ${d.title}`);
      this.store.updateDraft(d, { revisions: (d.revisions ?? 0) + 1 });
      this.requeue(d, 'rewrite');
      return;
    }
    log.warn(`Ajanlar reddetti (${tally}); karar senin: ${d.title}`);
    this.notify('Ajanlar reddetti', `${d.title} · karar senin`);
  }

  private enqueueUpload(d: Draft) {
    this.enqueue(`upload:${d.id}`, `YouTube’a yükleniyor: ${d.title}`, async () => {
      if (d.status !== 'approved') return;
      try {
        await uploadDraft(this.ctx, d);
        log.ok(`YouTube’a yüklendi, ${when(d.slot)} yayınlanacak: ${d.title}`);
      } catch (e) {
        const attempts = (d.uploadAttempts ?? 0) + 1;
        const waitMin = Math.min(120, 5 * 2 ** (attempts - 1));
        this.store.updateDraft(d, {
          status: 'approved',
          error: msg(e),
          uploadAttempts: attempts,
          nextAttemptAt: new Date(Date.now() + waitMin * 60_000).toISOString(),
        });
        log.error(`YouTube yüklemesi başarısız (${d.title}), ${waitMin} dk sonra tekrar denenecek: ${msg(e)}`);
        this.notify('YouTube yüklemesi başarısız', `${d.title}: ${msg(e)}`);
      }
    });
  }

  // ---------- periodic work ----------

  /** Runs the periodic checks now; a call that arrives mid-run gets one more run right after, so new work is never left for the next minute. */
  tick(): Promise<void> {
    if (this.ticking) {
      this.tickAgain = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      do {
        this.tickAgain = false;
        await this.runTick();
      } while (this.tickAgain);
    })().finally(() => (this.ticking = undefined));
    return this.ticking;
  }

  private async runTick() {
    try {
      await this.syncSources();
    } catch (e) {
      log.error(`OpusClip kontrolü: ${msg(e)}`);
    }
    this.autoPrepare();
    for (const d of this.store.data.drafts) if (d.status === 'approved' && due(d.nextAttemptAt)) this.enqueueUpload(d);
    if (!this.youtube.status().connected) return;
    if (this.settings.coverEnabled) {
      for (const d of this.store.data.drafts) {
        if (d.status === 'scheduled' && d.youtubeId && d.hasCover && !d.thumbnailSet && !d.thumbnailError && due(d.nextThumbAt)) this.enqueueThumbnail(d);
      }
    }
    const checked = this.store.data.statsCheckedAt;
    if (!checked || Date.now() - Date.parse(checked) >= STATS_EVERY_MS) {
      try {
        await this.refreshStats();
        await this.refreshInsights();
      } catch (e) {
        log.warn(`YouTube sonuçları ya da kanal dersleri güncellenemedi: ${msg(e)}`);
      }
    }
  }

  /** The cover can only be set once YouTube has finished processing the video, so this waits and retries. */
  private enqueueThumbnail(d: Draft) {
    this.enqueue(`thumb:${d.id}`, `Kapak yükleniyor: ${d.title}`, async () => {
      const attempts = (d.thumbnailAttempts ?? 0) + 1;
      try {
        if (await setThumbnailFor(this.ctx, d)) {
          this.store.updateDraft(d, { thumbnailSet: true, nextThumbAt: undefined });
          log.ok(`Kapak YouTube’a yüklendi: ${d.title}`);
        } else if (attempts >= 80) {
          this.store.updateDraft(d, { thumbnailError: 'YouTube videoyu saatlerdir işliyor; kapak yüklenemedi', thumbnailAttempts: attempts });
        } else {
          this.store.updateDraft(d, { thumbnailAttempts: attempts, nextThumbAt: later(3 * 60_000) });
        }
      } catch (e) {
        if (e instanceof ThumbnailForbiddenError || attempts >= 8) {
          this.store.updateDraft(d, { thumbnailError: msg(e), thumbnailAttempts: attempts });
          log.warn(`Kapak yüklenemedi (${d.title}): ${msg(e)}`);
          this.notify('Kapak yüklenemedi', msg(e));
          return;
        }
        this.store.updateDraft(d, { thumbnailAttempts: attempts, nextThumbAt: later(Math.min(120, 5 * 2 ** (attempts - 1)) * 60_000) });
        log.warn(`Kapak yüklenemedi, tekrar denenecek (${d.title}): ${msg(e)}`);
      }
    });
  }

  /** Fetches YouTube's public counts for shorts published in the last 60 days and flags videos YouTube turned down. */
  async refreshStats(): Promise<void> {
    const now = Date.now();
    const live = this.store.data.drafts.filter(
      (d) => d.status === 'scheduled' && d.youtubeId && d.slot && Date.parse(d.slot) <= now && now - Date.parse(d.slot) < 60 * 86_400_000,
    );
    const stats = live.length ? await this.youtube.videoStats(live.map((d) => d.youtubeId as string)) : new Map();
    for (const d of live) {
      const st = stats.get(d.youtubeId as string);
      const hours = (now - Date.parse(d.slot as string)) / 3_600_000;
      let problem = '';
      if (!st) problem = 'Video YouTube’da bulunamadı (silinmiş olabilir)';
      else {
        d.stats = { views: st.views, likes: st.likes, comments: st.comments, checkedAt: iso() };
        if (!d.early && hours >= 48) d.early = { views: st.views, likes: st.likes, comments: st.comments, hoursLive: Math.round(hours) };
        if (['rejected', 'failed', 'deleted'].includes(st.uploadStatus)) problem = `YouTube videoyu reddetti: ${REJECTION[st.problem] ?? (st.problem || st.uploadStatus)}`;
        else if (st.privacy === 'private' && hours > 2) problem = 'Video yayın saatinde herkese açılmadı, hâlâ gizli';
      }
      if (problem && problem !== d.ytProblem) {
        log.error(`${d.title}: ${problem}`);
        this.notify('YouTube’da bir videoda sorun var', `${d.title}: ${problem}`);
      }
      d.ytProblem = problem || undefined;
    }
    this.store.data.statsCheckedAt = iso();
    this.store.save();
  }

  /**
   * Has Claude turn the channel's results into lessons for the script writer and the review panel.
   * On its own it waits for a few results and then refreshes as new ones arrive or weekly; `force` is the panel's button.
   */
  async refreshInsights(force = false): Promise<Insights | undefined> {
    const s = this.settings;
    const rows = results(this.ctx);
    if (force && !s.anthropicApiKey) throw new Error('Claude API anahtarı yok (Ayarlar → Claude)');
    if (force && !rows.length) throw new Error('Henüz yayınlanıp sonucu gelen video yok');
    if (!s.anthropicApiKey || !rows.length) return undefined;
    const prev = this.store.data.insights;
    const stale = !prev || rows.length - prev.basedOn >= 2 || Date.now() - Date.parse(prev.at) > 7 * 86_400_000;
    if (!force && (rows.length < LESSONS_MIN_RESULTS || !stale)) return prev;
    // The 60 newest are plenty and keep the request small as the channel grows.
    const lessons = await new LessonWriter(s.anthropicApiKey, s.claudeModel, this.ctx.endpoints.claude).write(rows.slice(0, 60), s.language, s.channelStyle);
    this.store.data.insights = { lessons, basedOn: rows.length, at: iso() };
    this.store.save();
    log.ok(`Kanal dersleri güncellendi (${rows.length} videonun sonucundan)`);
    return this.store.data.insights;
  }

  private opus() {
    return new OpusClient(this.settings.opusApiKey, this.settings.opusOrgId, this.ctx.endpoints.opus);
  }

  private async syncSources() {
    if (!this.settings.opusApiKey) return;
    const pollMs = this.o.opusPollMs ?? 60_000;
    const later = (ms: number) => new Date(Date.now() + ms).toISOString();
    for (const src of this.store.data.sources) {
      if (!due(src.nextCheckAt)) continue;
      if (src.stage === 'submitting') {
        try {
          const p = await this.opus().createProject(src.url, this.settings, src.prompt);
          Object.assign(src, { projectId: p.projectId, opusStage: p.stage, stage: 'processing', error: undefined, nextCheckAt: later(pollMs) });
          log.info(`OpusClip projesi açıldı (${p.projectId}): ${src.url}`);
        } catch (e) {
          if (e instanceof OpusBusyError) Object.assign(src, { error: e.message, nextCheckAt: later(Math.max(pollMs, 120_000)) });
          else Object.assign(src, { stage: 'failed', error: msg(e) });
          if (!(e instanceof OpusBusyError)) log.error(`OpusClip videoyu kabul etmedi (${src.url}): ${msg(e)}`);
        }
        this.store.save();
      } else if (src.stage === 'processing' && src.projectId) {
        try {
          const p = await this.opus().getProject(src.projectId);
          src.opusStage = p.stage;
          src.error = undefined;
          if (p.stage === 'COMPLETE') {
            const items = await this.opus().listClips(src.projectId);
            this.addClips(src, items);
            Object.assign(src, { stage: 'complete', clipCount: items.length, nextCheckAt: undefined });
            log.ok(`OpusClip ${items.length} klip çıkardı: ${src.url}`);
          } else if (p.error) {
            Object.assign(src, { stage: 'failed', error: p.error });
            log.error(`OpusClip projesi başarısız (${src.url}): ${p.error}`);
          } else {
            src.nextCheckAt = later(pollMs);
          }
        } catch (e) {
          Object.assign(src, { error: msg(e), nextCheckAt: later(Math.max(pollMs, 120_000)) });
        }
        this.store.save();
      }
    }
  }

  /** Keeps OpusClip's order; clips beyond the best N are kept but set aside, so they can still be used by hand. */
  private addClips(src: Source, items: OpusClipItem[]) {
    const now = iso();
    const topN = this.settings.opusTopN;
    items.forEach((it, i) => {
      if (this.store.data.clips.some((c) => c.key === it.id)) return;
      this.store.data.clips.push({
        key: it.id,
        sourceId: src.id,
        projectId: it.projectId ?? src.projectId ?? '',
        curationId: it.curationId ?? it.id.split('.').pop() ?? it.id,
        rank: i + 1,
        title: it.title ?? '',
        description: it.description ?? '',
        hashtags: it.hashtags ?? '',
        text: it.text ?? '',
        durationMs: it.durationMs ?? 0,
        keywords: it.keywords ?? [],
        previewUrl: it.uriForPreview ?? '',
        exportUrl: it.uriForExport ?? '',
        status: i < topN ? 'new' : 'skipped',
        createdAt: now,
      });
    });
  }

  /** Best unused clip: OpusClip's #1 of every source before any #2, older sources first. */
  private bestClip(): Clip | undefined {
    const added = new Map(this.store.data.sources.map((s) => [s.id, s.createdAt]));
    return this.store.data.clips
      .filter((c) => c.status === 'new')
      .sort((a, b) => a.rank - b.rank || (added.get(a.sourceId) ?? '').localeCompare(added.get(b.sourceId) ?? ''))[0];
  }

  private canPrepare(): boolean {
    const s = this.settings;
    return Boolean(s.anthropicApiKey && s.elevenApiKey && s.voiceId && !this.ffmpegError);
  }

  /**
   * With the review panel deciding, enough clips are prepared to keep `planAhead` publish slots filled.
   * Otherwise (or until YouTube is connected) it keeps `draftBuffer` drafts waiting for the owner.
   */
  private autoPrepare() {
    if (!this.settings.autoPrepare || !this.canPrepare()) return;
    const drafts = this.store.data.drafts;
    let need: number;
    if (this.settings.reviewMode === 'agents' && this.youtube.status().connected) {
      const now = Date.now();
      const ahead = drafts.filter((d) => BOOKED.includes(d.status) && d.slot && Date.parse(d.slot) > now).length;
      need = this.settings.planAhead - ahead - drafts.filter((d) => IN_PIPELINE.includes(d.status)).length;
    } else {
      need = this.settings.draftBuffer - drafts.filter((d) => IN_BUFFER.includes(d.status)).length;
    }
    for (; need > 0; need--) {
      const clip = this.bestClip();
      if (!clip) return;
      this.draftClip(clip.key);
      log.info(`Otomatik taslak başlatıldı (OpusClip sırası #${clip.rank}): ${clip.title}`);
    }
  }

  // ---------- actions from the panel ----------

  /** Validates new or changed API keys with calls that cost nothing; if one fails, nothing is saved. */
  async saveSettings(body: Record<string, unknown>): Promise<void> {
    const next = applySettingsInput(this.settings, body);
    const cur = this.settings;
    const checks: Promise<void>[] = [];
    const verify = (name: string, run: () => Promise<void>) =>
      checks.push(
        run().catch((e) => {
          throw new Error(`${name} doğrulanamadı, ayarlar kaydedilmedi: ${msg(e)}`);
        }),
      );
    if (next.opusApiKey && (next.opusApiKey !== cur.opusApiKey || next.opusOrgId !== cur.opusOrgId)) {
      verify('OpusClip anahtarı', () => new OpusClient(next.opusApiKey, next.opusOrgId, this.ctx.endpoints.opus).check());
    }
    if (next.anthropicApiKey && (next.anthropicApiKey !== cur.anthropicApiKey || next.claudeModel !== cur.claudeModel)) {
      verify('Claude anahtarı', () => new ScriptWriter(next.anthropicApiKey, next.claudeModel, this.ctx.endpoints.claude).check());
    }
    if (next.elevenApiKey && next.elevenApiKey !== cur.elevenApiKey) {
      verify('ElevenLabs anahtarı', () => new ElevenClient(next.elevenApiKey, this.ctx.endpoints.eleven).check());
    }
    await Promise.all(checks);
    this.settings = next;
    writeSettings(this.paths.settingsFile, next);
    log.info(checks.length ? 'Ayarlar kaydedildi, yeni API anahtarları doğrulandı' : 'Ayarlar kaydedildi');
    this.o.onSettingsSaved?.(next);
    void this.tick();
  }

  settingsView() {
    return { ...settingsView(this.settings), musicDir: this.paths.musicDir, dataDir: this.paths.home };
  }

  async voices(): Promise<Voice[]> {
    if (!this.settings.elevenApiKey) throw new Error('Önce ElevenLabs API anahtarını kaydet');
    return new ElevenClient(this.settings.elevenApiKey, this.ctx.endpoints.eleven).voices();
  }

  addSource(url: string, note: string, prompt: string): Source {
    if (!this.settings.opusApiKey) throw new Error('Önce Ayarlar → OpusClip bölümüne API anahtarını gir');
    const clean = url.trim();
    let parsed: URL;
    try {
      parsed = new URL(clean);
    } catch {
      throw new Error('Geçerli bir video bağlantısı gir (https://...)');
    }
    if (!/^https?:$/.test(parsed.protocol) || clean.length > 2000) throw new Error('Geçerli bir video bağlantısı gir (https://...)');
    if (this.store.data.sources.some((s) => s.url === clean && s.stage !== 'failed')) throw new Error('Bu video zaten eklenmiş');
    const src: Source = {
      id: newId(),
      url: clean,
      note: note.trim().slice(0, 1000),
      prompt: prompt.trim().slice(0, 300),
      createdAt: iso(),
      stage: 'submitting',
    };
    this.store.data.sources.push(src);
    this.store.save();
    log.info(`Kaynak eklendi, OpusClip’e gönderiliyor: ${clean}`);
    void this.tick();
    return src;
  }

  checkSource(id: string): void {
    const src = this.store.source(id);
    if (src.stage === 'failed') Object.assign(src, { stage: src.projectId ? 'processing' : 'submitting', error: undefined });
    src.nextCheckAt = undefined;
    this.store.save();
    void this.tick();
  }

  removeSource(id: string): void {
    const src = this.store.source(id);
    this.store.data.sources = this.store.data.sources.filter((s) => s !== src);
    // Clips that already have a draft stay, the draft needs them.
    this.store.data.clips = this.store.data.clips.filter((c) => c.sourceId !== id || c.status === 'drafted');
    this.store.save();
    log.info(`Kaynak silindi: ${src.url}`);
  }

  skipClip(key: string, skip: boolean): void {
    const c = this.store.clip(key);
    if (c.status === 'drafted') throw new Error('Bu klipten zaten taslak hazırlandı');
    c.status = skip ? 'skipped' : 'new';
    this.store.save();
  }

  draftClip(key: string, instructions = ''): Draft {
    const clip = this.store.clip(key);
    if (clip.status === 'drafted') throw new Error('Bu klipten zaten taslak hazırlandı');
    const now = iso();
    const d: Draft = {
      id: newId(),
      clipKey: key,
      status: 'queued',
      mode: 'full',
      instructions: instructions.trim().slice(0, 1000),
      hook: '',
      narration: '',
      title: clip.title,
      description: '',
      tags: [],
      createdAt: now,
      updatedAt: now,
    };
    clip.status = 'drafted';
    this.store.data.drafts.push(d);
    this.store.save();
    this.enqueuePrepare(d);
    return d;
  }

  private requeue(d: Draft, mode: PrepareMode) {
    this.store.updateDraft(d, { status: 'queued', mode, error: undefined, step: undefined });
    this.enqueuePrepare(d);
  }

  private editable(id: string): Draft {
    const d = this.store.draft(id);
    if (!EDITABLE.includes(d.status)) throw new Error('Bu taslak şu an değiştirilemez');
    return d;
  }

  /** Saves the user's edits; the video is rebuilt only if the voice or the on-screen text changed. */
  saveDraft(id: string, body: Record<string, unknown>): void {
    const d = this.editable(id);
    const str = (v: unknown, max: number) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
    const patch: Partial<Draft> = {};
    if ('hook' in body) patch.hook = str(body.hook, 60).replace(/\s+/g, ' ');
    if ('narration' in body) patch.narration = str(body.narration, 3000).replace(/\s+/g, ' ');
    if ('title' in body) patch.title = str(body.title, 100).replace(/[<>\n]/g, '');
    if ('description' in body) patch.description = str(body.description, 4000).replace(/[<>]/g, '');
    if ('tags' in body) {
      const raw = Array.isArray(body.tags) ? body.tags.map(String) : String(body.tags ?? '').split(',');
      patch.tags = fitTags(raw);
    }
    if ('instructions' in body) patch.instructions = str(body.instructions, 1000);
    if ('coverText' in body) patch.coverText = str(body.coverText, 30).replace(/\s+/g, ' ');
    if (patch.narration !== undefined && !patch.narration) throw new Error('Seslendirme metni boş olamaz');
    const videoChange = (patch.hook !== undefined && patch.hook !== d.hook) || (patch.narration !== undefined && patch.narration !== d.narration);
    const coverChange = patch.coverText !== undefined && patch.coverText !== (d.coverText ?? '');
    this.store.updateDraft(d, patch);
    if (videoChange || d.status === 'failed') this.requeue(d, 'refresh');
    else if (coverChange && d.hasCover) this.enqueueCover(d);
  }

  /** Only the cover text changed: redraws the cover and keeps the video and the panel's verdict. */
  private enqueueCover(d: Draft) {
    this.enqueue(`cover:${d.id}`, `Kapak yeniden hazırlanıyor: ${d.title}`, async () => {
      try {
        await renderCoverFor(this.ctx, d);
        this.store.updateDraft(d, {}); // new updatedAt, so the panel loads the new image
        log.ok(`Kapak yeniden hazırlandı: ${d.title}`);
      } catch (e) {
        log.error(`Kapak hazırlanamadı (${d.title}): ${msg(e)}`);
      }
    });
  }

  rewriteDraft(id: string, instructions?: string): void {
    const d = this.editable(id);
    if (instructions !== undefined) d.instructions = instructions.trim().slice(0, 1000);
    this.requeue(d, 'rewrite');
  }

  revoiceDraft(id: string): void {
    this.requeue(this.editable(id), 'revoice');
  }

  retryDraft(id: string): void {
    const d = this.store.draft(id);
    if (d.status !== 'failed') throw new Error('Sadece hata veren taslaklar tekrar denenir');
    this.requeue(d, d.mode);
  }

  approveDraft(id: string): string {
    const d = this.store.draft(id);
    if (d.status !== 'ready') throw new Error('Sadece hazır taslaklar onaylanabilir');
    if (!this.youtube.status().connected) throw new Error('Önce YouTube kanalını bağla (Ayarlar → YouTube)');
    const slot = slotAfterBooked(this.ctx).toISOString();
    this.store.updateDraft(d, { status: 'approved', slot, uploadAttempts: 0, nextAttemptAt: undefined, error: undefined });
    log.info(`Onaylandı, ${when(slot)} yayınlanacak: ${d.title}`);
    void this.tick();
    return slot;
  }

  unapproveDraft(id: string): void {
    const d = this.store.draft(id);
    if (d.status !== 'approved') throw new Error('Bu video zaten YouTube’a yüklendi ya da onaylı değil');
    this.store.updateDraft(d, { status: 'ready', slot: undefined, error: undefined, nextAttemptAt: undefined });
  }

  rejectDraft(id: string): void {
    const d = this.store.draft(id);
    if (!['queued', 'ready', 'failed'].includes(d.status)) throw new Error('Bu taslak şu an reddedilemez');
    this.store.updateDraft(d, { status: 'rejected', error: undefined });
  }

  retryUpload(id: string): void {
    const d = this.store.draft(id);
    if (d.status !== 'approved') throw new Error('Bu video yükleme beklemiyor');
    this.store.updateDraft(d, { nextAttemptAt: undefined });
    void this.tick();
  }

  /** Asks the review panel again, e.g. after the owner edited a short; in agents mode an approval publishes it. */
  reviewNow(id: string): void {
    const d = this.store.draft(id);
    if (d.status !== 'ready' || !d.hasVideo) throw new Error('Sadece videosu hazır taslaklar değerlendirilebilir');
    this.store.updateDraft(d, { status: 'reviewing', error: undefined });
    this.enqueueReview(d);
  }

  // ---------- panel view ----------

  setupIssues(): SetupIssue[] {
    const s = this.settings;
    const out: SetupIssue[] = [];
    if (this.ffmpegError) out.push({ text: `ffmpeg çalışmıyor: ${this.ffmpegError}`, section: 'video' });
    if (!s.opusApiKey) out.push({ text: 'OpusClip API anahtarı girilmedi', section: 'opus' });
    if (!s.anthropicApiKey) out.push({ text: 'Claude API anahtarı girilmedi (seslendirme metni için)', section: 'claude' });
    if (!s.elevenApiKey) out.push({ text: 'ElevenLabs API anahtarı girilmedi', section: 'eleven' });
    else if (!s.voiceId) out.push({ text: 'Seslendirme sesi seçilmedi', section: 'eleven' });
    if (!s.googleClientId) out.push({ text: 'Google Client ID girilmedi (YouTube’a yükleme için)', section: 'youtube' });
    else if (!this.youtube.status().connected) out.push({ text: 'YouTube kanalı bağlı değil', section: 'youtube' });
    return out;
  }

  status() {
    const s = this.settings;
    const sources = new Map(this.store.data.sources.map((x) => [x.id, x]));
    const clips = new Map(this.store.data.clips.map((c) => [c.key, c]));
    const clipView = (c: Clip) => {
      const local = clipFile(this.ctx, c);
      return {
        ...c,
        seconds: c.durationMs / 1000,
        sourceUrl: sources.get(c.sourceId)?.url ?? '',
        previewSrc: existsSync(local) ? `/media/clips/${safeName(c.key)}.mp4` : c.previewUrl,
      };
    };
    return {
      now: iso(),
      busy: this.busy ?? null,
      queued: this.queue.length,
      youtube: this.youtube.status(),
      setup: this.setupIssues(),
      nextSlot: slotAfterBooked(this.ctx).toISOString(),
      schedule: {
        intervalDays: s.intervalDays,
        publishTime: s.publishTime,
        autoPrepare: s.autoPrepare,
        draftBuffer: s.draftBuffer,
        reviewMode: s.reviewMode,
        reviewMinScore: s.reviewMinScore,
        planAhead: s.planAhead,
        opusTopN: s.opusTopN,
      },
      sources: [...this.store.data.sources].reverse().map((x) => ({ ...x, stageName: x.opusStage ? OPUS_STAGE_NAMES[x.opusStage] ?? x.opusStage : '' })),
      clips: this.store.data.clips
        .map(clipView)
        .sort((a, b) => (sources.get(b.sourceId)?.createdAt ?? '').localeCompare(sources.get(a.sourceId)?.createdAt ?? '') || a.rank - b.rank),
      drafts: [...this.store.data.drafts]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((d) => {
          const c = clips.get(d.clipKey);
          return {
            ...d,
            videoSrc: d.hasVideo ? `/media/drafts/${d.id}/final.mp4?v=${encodeURIComponent(d.updatedAt)}` : null,
            coverSrc: d.hasCover ? `/media/drafts/${d.id}/cover.jpg?v=${encodeURIComponent(d.updatedAt)}` : null,
            clip: c ? { title: c.title, rank: c.rank, seconds: c.durationMs / 1000, sourceUrl: sources.get(c.sourceId)?.url ?? '' } : null,
            targetWords: targetWords((d.clipSeconds ?? (c ? c.durationMs / 1000 : 30)) || 30),
          };
        }),
      results: results(this.ctx),
      insights: this.store.data.insights ?? null,
      statsCheckedAt: this.store.data.statsCheckedAt ?? null,
      logs: log.recent().slice(-200).reverse(),
    };
  }
}

export async function startRuntime(o: RuntimeOptions): Promise<Runtime> {
  const rt = new Runtime(o);
  await rt.start();
  return rt;
}
