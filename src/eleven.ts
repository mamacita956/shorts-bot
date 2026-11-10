import { HttpError, sendJson } from './http';

export interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

export interface Voice {
  id: string;
  name: string;
  category: string;
  labels: Record<string, string>;
  previewUrl: string;
}

export interface SpeakOptions {
  voiceId: string;
  text: string;
  modelId: string;
  language: string;
  speed: number;
  stability: number;
}

export class ElevenClient {
  constructor(
    private readonly apiKey: string,
    private readonly base = 'https://api.elevenlabs.io',
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    try {
      return await sendJson<T>('ElevenLabs', `${this.base}${path}`, {
        timeoutMs: 180_000,
        ...init,
        headers: { 'xi-api-key': this.apiKey, Accept: 'application/json', ...(init.headers as Record<string, string>) },
      });
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) throw new Error('ElevenLabs API anahtarı geçersiz ya da bu işlem için yetkisi yok');
      if (e instanceof HttpError && e.status === 429) throw new Error('ElevenLabs aynı anda çok fazla istek aldı ya da kotan doldu; biraz sonra tekrar dene');
      throw e;
    }
  }

  /** Speech plus the start/end time of every character, which the word-by-word captions are built from. */
  async speak(o: SpeakOptions): Promise<{ audio: Buffer; alignment: Alignment }> {
    const body: Record<string, unknown> = {
      text: o.text,
      model_id: o.modelId,
      voice_settings: { stability: o.stability, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: o.speed },
    };
    // language_code is rejected by the multilingual_v2 models.
    if (!o.modelId.startsWith('eleven_multilingual_v2')) body.language_code = o.language;
    const r = await this.call<{ audio_base64?: string; alignment?: Alignment | null; normalized_alignment?: Alignment | null }>(
      `/v1/text-to-speech/${encodeURIComponent(o.voiceId)}/with-timestamps?output_format=mp3_44100_128`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    const alignment = r.alignment ?? r.normalized_alignment;
    if (!r.audio_base64 || !alignment?.characters?.length) throw new Error('ElevenLabs ses ya da zamanlama bilgisi döndürmedi');
    return { audio: Buffer.from(r.audio_base64, 'base64'), alignment };
  }

  async voices(): Promise<Voice[]> {
    const out: Voice[] = [];
    let token = '';
    for (let page = 0; page < 5; page++) {
      const q = new URLSearchParams({ page_size: '100', include_total_count: 'false' });
      if (token) q.set('next_page_token', token);
      const r = await this.call<{
        voices?: { voice_id: string; name?: string; category?: string; labels?: Record<string, string>; preview_url?: string | null }[];
        has_more?: boolean;
        next_page_token?: string | null;
      }>(`/v2/voices?${q}`);
      for (const v of r.voices ?? []) {
        out.push({ id: v.voice_id, name: v.name ?? v.voice_id, category: v.category ?? '', labels: v.labels ?? {}, previewUrl: v.preview_url ?? '' });
      }
      if (!r.has_more || !r.next_page_token) break;
      token = r.next_page_token;
    }
    return out;
  }
}
