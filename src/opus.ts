import { HttpError, sendJson } from './http';
import { CLIP_BUCKETS, type Settings } from './settings';

export interface OpusProject {
  projectId: string;
  stage: string;
  error?: string;
}

export interface OpusClipItem {
  id: string;
  projectId: string;
  curationId: string;
  title?: string;
  description?: string;
  hashtags?: string;
  text?: string;
  durationMs: number;
  keywords?: string[];
  uriForPreview?: string;
  uriForExport?: string;
}

/** OpusClip is at its concurrency or rate limit; the same request can be retried later. */
export class OpusBusyError extends Error {}

export const OPUS_STAGE_NAMES: Record<string, string> = {
  PENDING: 'Bekliyor',
  QUEUED: 'Sırada',
  IMPORT: 'Video alınıyor',
  CURATE: 'Klipler seçiliyor',
  REFINE: 'Klipler iyileştiriliyor',
  RENDER: 'Klip videoları hazırlanıyor',
  UPLOAD: 'Yükleniyor',
  COMPLETE: 'Bitti',
  STALLED: 'Takıldı, OpusClip tekrar deniyor',
};

export class OpusClient {
  constructor(
    private readonly apiKey: string,
    private readonly orgId = '',
    private readonly base = 'https://api.opus.pro',
  ) {}

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' };
    if (json) h['Content-Type'] = 'application/json';
    if (this.orgId) h['x-opus-org-id'] = this.orgId;
    return h;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    try {
      return await sendJson<T>('OpusClip', `${this.base}${path}`, { timeoutMs: 60_000, ...init });
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      if (e.status === 401) throw new Error('OpusClip API anahtarı geçersiz');
      if (e.status === 429) {
        throw new OpusBusyError(
          e.headers.get('x-cap-reason') === 'concurrent'
            ? 'OpusClip aynı anda en fazla 4 proje işliyor; biri bitince tekrar denenecek'
            : 'OpusClip istek sınırına gelindi; biraz sonra tekrar denenecek',
        );
      }
      if (e.status === 403) {
        let code = '';
        let resetAt = '';
        try {
          const j = JSON.parse(e.body);
          code = j.code ?? '';
          resetAt = j.reset_at ?? '';
        } catch {
          // body is not JSON
        }
        if (code === 'API_MONTHLY_CAP_REACHED') {
          throw new Error(`OpusClip aylık API sınırı (900 kredi) doldu${resetAt ? `; ${resetAt.slice(0, 10)} tarihinde sıfırlanır` : ''}`);
        }
        throw new Error(`OpusClip isteği reddetti (403). Planında API erişimi açık mı? ${e.message}`);
      }
      throw e;
    }
  }

  async createProject(videoUrl: string, s: Settings, prompt = ''): Promise<OpusProject> {
    const body: Record<string, unknown> = {
      videoUrl,
      curationPref: {
        model: s.opusModel,
        clipDurations: s.opusClipBuckets.map((b) => CLIP_BUCKETS[b]),
        genre: s.opusGenre,
        ...(prompt && s.opusModel === 'ClipAnything' ? { customPrompt: prompt } : {}),
      },
      importPref: { sourceLang: s.opusSourceLang },
      // The narration brings its own captions, so OpusClip's are off unless asked for.
      renderPref: { layoutAspectRatio: 'portrait', ...(s.opusCaptions ? {} : { enableCaption: false }) },
      ...(s.opusBrandTemplateId ? { brandTemplateId: s.opusBrandTemplateId } : {}),
    };
    const r = await this.call<{ id?: string; projectId?: string; stage?: string; error?: string }>('/api/clip-projects', {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(body),
    });
    const projectId = r.projectId ?? r.id;
    if (!projectId) throw new Error('OpusClip proje numarası döndürmedi');
    return { projectId, stage: r.stage ?? 'QUEUED', error: r.error ?? undefined };
  }

  async getProject(projectId: string): Promise<OpusProject> {
    const r = await this.call<{ stage?: string; error?: string | null }>(`/api/clip-projects/${encodeURIComponent(projectId)}`, {
      headers: this.headers(),
    });
    return { projectId, stage: r.stage ?? 'PENDING', error: r.error ?? undefined };
  }

  /** All clips of a finished project, in OpusClip's order (highest virality score first). */
  async listClips(projectId: string): Promise<OpusClipItem[]> {
    const pageSize = 50;
    const all: OpusClipItem[] = [];
    for (let page = 1; page <= 20; page++) {
      const q = new URLSearchParams({ q: 'findByProjectId', projectId, pageNum: String(page), pageSize: String(pageSize) });
      const r = await this.call<OpusClipItem[] | { data?: OpusClipItem[] }>(`/api/exportable-clips?${q}`, { headers: this.headers() });
      const items = Array.isArray(r) ? r : r.data ?? [];
      all.push(...items);
      if (items.length < pageSize) break;
    }
    return all;
  }
}
