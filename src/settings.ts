import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const OPUS_MODELS = ['ClipAnything', 'ClipBasic'] as const;
export const OPUS_GENRES = [
  'Auto', 'Sports commentary', 'Commentary', 'Podcast', 'Q&A', 'Comedy', 'Gaming', 'News', 'Vlog', 'Motivational speech',
  'Listicle', 'Product reviews', 'How-to', 'Marketing', 'Webinar', 'Academic', 'Church', 'Others',
] as const;
/** The clip-length buckets the OpusClip API accepts in `curationPref.clipDurations`. */
export const CLIP_BUCKETS: Record<string, [number, number]> = {
  '0-30': [0, 30],
  '30-60': [30, 60],
  '0-90': [0, 90],
  '60-90': [60, 90],
  '90-180': [90, 180],
};
export const CLAUDE_MODELS: Record<string, string> = {
  'claude-opus-5-5': 'Claude Opus 5.5 (en iyi sonuç)',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5 (daha ucuz)',
  'claude-haiku-5-5': 'Claude Haiku 5.5 (en ucuz)',
};
export const ELEVEN_MODELS: Record<string, string> = {
  eleven_multilingual_v2: 'Multilingual v2 (dengeli, Türkçe destekli)',
  eleven_v4: 'Eleven v4 (en duygulu)',
  eleven_v3: 'Eleven v3 (dramatik)',
  eleven_flash_v2_5: 'Flash v2.5 (hızlı, yarı fiyat)',
};
export const CATEGORIES: Record<string, string> = {
  '17': 'Spor',
  '24': 'Eğlence',
  '23': 'Komedi',
  '22': 'Kişiler ve Bloglar',
  '20': 'Oyun',
  '25': 'Haberler ve Politika',
  '26': 'Nasıl Yapılır ve Stil',
  '28': 'Bilim ve Teknoloji',
};
export const LANGUAGES: Record<string, string> = {
  tr: 'Türkçe',
  en: 'İngilizce',
  de: 'Almanca',
  es: 'İspanyolca',
  fr: 'Fransızca',
  pt: 'Portekizce',
  ar: 'Arapça',
};

export interface Settings {
  opusApiKey: string;
  opusOrgId: string;
  opusModel: (typeof OPUS_MODELS)[number];
  opusGenre: string;
  opusClipBuckets: string[];
  opusSourceLang: string;
  opusBrandTemplateId: string;
  opusCaptions: boolean;
  anthropicApiKey: string;
  claudeModel: string;
  language: string;
  channelStyle: string;
  elevenApiKey: string;
  elevenModel: string;
  voiceId: string;
  voiceName: string;
  voiceSpeed: number;
  voiceStability: number;
  /** Percent of the clip's own sound kept under the voiceover. */
  originalVolume: number;
  musicVolume: number;
  /** How long the headline stays on screen; 0 keeps it for the whole video. */
  hookSeconds: number;
  captionPosition: 'lower' | 'middle';
  highlightColor: string;
  googleClientId: string;
  googleClientSecret: string;
  categoryId: string;
  madeForKids: boolean;
  syntheticMedia: boolean;
  descriptionFooter: string;
  intervalDays: number;
  publishTime: string;
  autoPrepare: boolean;
  draftBuffer: number;
  /** Desktop app: start hidden in the tray when Windows starts. */
  startAtLogin: boolean;
  /** agents: the review panel decides and approved shorts upload on their own · advisory: the panel comments, the owner decides · off */
  reviewMode: (typeof REVIEW_MODES)[number];
  /** Lowest average panel score that can pass. */
  reviewMinScore: number;
  /** How many times a turned-down short is rewritten with the panel's feedback before it goes to the owner. */
  reviewRevisions: number;
  /** Only OpusClip's best N clips of each source are used. */
  opusTopN: number;
  /** In agents mode, how many publish slots are kept filled ahead. */
  planAhead: number;
  /** Make a thumbnail for every short and set it on YouTube. */
  coverEnabled: boolean;
  /** What the clip agent looks for in video files. */
  clipWishes: string;
  /** 0-50 % of a landscape clip's width trimmed away in the vertical frame. */
  landscapeZoom: number;
}

export const REVIEW_MODES = ['agents', 'advisory', 'off'] as const;

export const DEFAULT_STYLE =
  'Futbol kanalı. Anlatıcı heyecanlı ama abartısız, samimi bir dille konuşur; kısa ve vurucu cümleler kurar. ' +
  'İlk cümle izleyiciyi hemen yakalar: bir soru ya da şaşırtıcı bir bilgi. ' +
  'Videoda görünenleri anlatır, kendi yorumunu katar. Son cümlede izleyiciye yorumlara yazması için kısa bir soru sorar.';

export const DEFAULTS: Settings = {
  opusApiKey: '',
  opusOrgId: '',
  opusModel: 'ClipAnything',
  opusGenre: 'Auto',
  opusClipBuckets: ['0-30', '30-60'],
  opusSourceLang: 'auto',
  opusBrandTemplateId: '',
  opusCaptions: false,
  anthropicApiKey: '',
  claudeModel: 'claude-opus-5-5',
  language: 'tr',
  channelStyle: DEFAULT_STYLE,
  elevenApiKey: '',
  elevenModel: 'eleven_multilingual_v2',
  voiceId: '',
  voiceName: '',
  voiceSpeed: 1,
  voiceStability: 0.45,
  originalVolume: 25,
  musicVolume: 12,
  hookSeconds: 0,
  captionPosition: 'lower',
  highlightColor: '#FFD400',
  googleClientId: '',
  googleClientSecret: '',
  categoryId: '17',
  madeForKids: false,
  syntheticMedia: false,
  descriptionFooter: '#shorts',
  intervalDays: 2,
  publishTime: '19:00',
  autoPrepare: true,
  draftBuffer: 2,
  startAtLogin: true,
  reviewMode: 'agents',
  reviewMinScore: 7,
  reviewRevisions: 1,
  opusTopN: 5,
  planAhead: 3,
  coverEnabled: true,
  clipWishes:
    'Goller, kaçan büyük pozisyonlar, kurtarışlar, çalımlar, tartışmalı pozisyonlar, kırmızı kartlar ve taraftar coşkusu. ' +
    'Her klip tek bir anı anlatsın: pozisyonun gelişimi, anın kendisi ve tepki.',
  landscapeZoom: 15,
};

export function loadSettings(path: string): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeSettings(path: string, s: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

const line = (v: unknown, max: number) => String(v ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max);
const text = (v: unknown, max: number) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);

function num(v: unknown, min: number, max: number, name: string, integer = false): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new Error(`${name} ${min} ile ${max} arasında ${integer ? 'bir tam sayı ' : ''}olmalı`);
  }
  return n;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], name: string): T {
  const s = String(v ?? '');
  if (!allowed.includes(s as T)) throw new Error(`Geçersiz ${name}: ${s}`);
  return s as T;
}

const SECRETS = ['opusApiKey', 'anthropicApiKey', 'elevenApiKey', 'googleClientSecret'] as const;

/** Applies the fields present in `body` on top of `current`. Empty secret fields keep the stored value. */
export function applySettingsInput(current: Settings, body: Record<string, unknown>): Settings {
  const s: Settings = { ...current };
  const has = (k: keyof Settings) => Object.prototype.hasOwnProperty.call(body, k);

  for (const k of SECRETS) {
    if (has(k)) {
      const v = line(body[k], 400);
      if (v) s[k] = v;
    }
  }
  if (has('opusOrgId')) {
    s.opusOrgId = line(body.opusOrgId, 80);
    if (s.opusOrgId && !/^[\w-]+$/.test(s.opusOrgId)) throw new Error('OpusClip Org ID geçersiz');
  }
  if (has('opusModel')) s.opusModel = oneOf(body.opusModel, OPUS_MODELS, 'OpusClip modeli');
  if (has('opusGenre')) s.opusGenre = oneOf(body.opusGenre, OPUS_GENRES, 'OpusClip türü');
  if (has('opusClipBuckets')) {
    const list = Array.isArray(body.opusClipBuckets) ? body.opusClipBuckets.map(String) : [];
    const valid = list.filter((b) => b in CLIP_BUCKETS);
    if (!valid.length) throw new Error('En az bir klip süresi seç');
    s.opusClipBuckets = [...new Set(valid)];
  }
  if (has('opusSourceLang')) {
    s.opusSourceLang = line(body.opusSourceLang, 10) || 'auto';
    if (s.opusSourceLang !== 'auto' && !/^[a-z]{2,3}$/.test(s.opusSourceLang)) throw new Error('Video dili "auto" ya da iki harfli dil kodu olmalı');
  }
  if (has('opusBrandTemplateId')) {
    s.opusBrandTemplateId = line(body.opusBrandTemplateId, 120);
    if (s.opusBrandTemplateId && !/^[\w.-]+$/.test(s.opusBrandTemplateId)) throw new Error('Marka şablonu ID geçersiz');
  }
  if (has('opusCaptions')) s.opusCaptions = body.opusCaptions === true;

  if (has('claudeModel')) s.claudeModel = oneOf(body.claudeModel, Object.keys(CLAUDE_MODELS), 'Claude modeli');
  if (has('language')) s.language = oneOf(body.language, Object.keys(LANGUAGES), 'dil');
  if (has('channelStyle')) s.channelStyle = text(body.channelStyle, 2000) || DEFAULT_STYLE;

  if (has('elevenModel')) s.elevenModel = oneOf(body.elevenModel, Object.keys(ELEVEN_MODELS), 'ElevenLabs modeli');
  if (has('voiceId')) {
    s.voiceId = line(body.voiceId, 64);
    if (s.voiceId && !/^[A-Za-z0-9]+$/.test(s.voiceId)) throw new Error('Ses ID geçersiz');
  }
  if (has('voiceName')) s.voiceName = line(body.voiceName, 120);
  if (has('voiceSpeed')) s.voiceSpeed = num(body.voiceSpeed, 0.7, 1.2, 'Konuşma hızı');
  if (has('voiceStability')) s.voiceStability = num(body.voiceStability, 0, 1, 'Ses sabitliği');

  if (has('originalVolume')) s.originalVolume = num(body.originalVolume, 0, 100, 'Orijinal ses seviyesi', true);
  if (has('musicVolume')) s.musicVolume = num(body.musicVolume, 0, 100, 'Müzik seviyesi', true);
  if (has('hookSeconds')) s.hookSeconds = num(body.hookSeconds, 0, 60, 'Başlık süresi');
  if (has('captionPosition')) s.captionPosition = oneOf(body.captionPosition, ['lower', 'middle'] as const, 'altyazı konumu');
  if (has('highlightColor')) {
    s.highlightColor = line(body.highlightColor, 7).toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(s.highlightColor)) throw new Error('Vurgu rengi #RRGGBB biçiminde olmalı');
  }

  if (has('googleClientId')) {
    s.googleClientId = line(body.googleClientId, 200);
    if (s.googleClientId && !s.googleClientId.endsWith('.apps.googleusercontent.com')) {
      throw new Error('Google Client ID ".apps.googleusercontent.com" ile biter; doğru alanı kopyaladığından emin ol');
    }
  }
  if (has('categoryId')) s.categoryId = oneOf(body.categoryId, Object.keys(CATEGORIES), 'kategori');
  if (has('madeForKids')) s.madeForKids = body.madeForKids === true;
  if (has('syntheticMedia')) s.syntheticMedia = body.syntheticMedia === true;
  if (has('descriptionFooter')) s.descriptionFooter = text(body.descriptionFooter, 500).replace(/[<>]/g, '');

  if (has('intervalDays')) s.intervalDays = num(body.intervalDays, 1, 14, 'Yayın aralığı (gün)', true);
  if (has('publishTime')) {
    const t = line(body.publishTime, 5);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error('Yayın saati SS:DD biçiminde olmalı (örnek 19:00)');
    s.publishTime = t;
  }
  if (has('autoPrepare')) s.autoPrepare = body.autoPrepare === true;
  if (has('draftBuffer')) s.draftBuffer = num(body.draftBuffer, 1, 5, 'Hazır taslak sayısı', true);
  if (has('startAtLogin')) s.startAtLogin = body.startAtLogin === true;
  if (has('reviewMode')) s.reviewMode = oneOf(body.reviewMode, REVIEW_MODES, 'değerlendirme modu');
  if (has('reviewMinScore')) s.reviewMinScore = num(body.reviewMinScore, 1, 10, 'Onay için en düşük puan');
  if (has('reviewRevisions')) s.reviewRevisions = num(body.reviewRevisions, 0, 3, 'Yeniden yazma hakkı', true);
  if (has('opusTopN')) s.opusTopN = num(body.opusTopN, 1, 50, 'Kullanılacak klip sayısı', true);
  if (has('planAhead')) s.planAhead = num(body.planAhead, 1, 15, 'İleriye planlanacak yayın sayısı', true);
  if (has('coverEnabled')) s.coverEnabled = body.coverEnabled === true;
  if (has('clipWishes')) s.clipWishes = String(body.clipWishes ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 1000);
  if (has('landscapeZoom')) s.landscapeZoom = num(body.landscapeZoom, 0, 50, 'Yatay videoda yakınlaştırma', true);
  return s;
}

const hint = (v: string) => (v ? `••••${v.slice(-4)}` : '');

/** Settings as the panel may see them: secrets replaced by their last four characters. */
export function settingsView(s: Settings) {
  const { opusApiKey, anthropicApiKey, elevenApiKey, googleClientSecret, ...rest } = s;
  return {
    ...rest,
    opusKeyHint: hint(opusApiKey),
    anthropicKeyHint: hint(anthropicApiKey),
    elevenKeyHint: hint(elevenApiKey),
    googleSecretHint: hint(googleClientSecret),
  };
}
