import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type SourceStage = 'submitting' | 'processing' | 'complete' | 'failed';

export interface Source {
  id: string;
  url: string;
  /** Context for Claude (who plays, which match...). */
  note: string;
  /** What OpusClip's ClipAnything model should look for, e.g. "goller ve kurtarışlar". */
  prompt: string;
  createdAt: string;
  stage: SourceStage;
  projectId?: string;
  /** OpusClip's own stage name (QUEUED, IMPORT, CURATE, ...). */
  opusStage?: string;
  error?: string;
  clipCount?: number;
  nextCheckAt?: string;
}

export type ClipStatus = 'new' | 'drafted' | 'skipped';

export interface Clip {
  /** OpusClip's composite id `{projectId}.{curationId}`. */
  key: string;
  sourceId: string;
  projectId: string;
  curationId: string;
  /** Position in OpusClip's list for its project; OpusClip sorts by virality score, best first. */
  rank: number;
  title: string;
  description: string;
  hashtags: string;
  text: string;
  durationMs: number;
  keywords: string[];
  previewUrl: string;
  exportUrl: string;
  status: ClipStatus;
  createdAt: string;
}

export type DraftStatus = 'queued' | 'preparing' | 'ready' | 'failed' | 'approved' | 'uploading' | 'scheduled' | 'rejected';
/** full: write, voice, render · rewrite: new script · refresh: re-voice only if the text changed · revoice: always re-voice */
export type PrepareMode = 'full' | 'rewrite' | 'refresh' | 'revoice';

export interface Draft {
  id: string;
  clipKey: string;
  status: DraftStatus;
  mode: PrepareMode;
  step?: string;
  error?: string;
  /** Extra direction for Claude, written by the user. */
  instructions: string;
  hook: string;
  narration: string;
  title: string;
  description: string;
  tags: string[];
  /** The narration the current voice file was generated from. */
  voicedNarration?: string;
  voiceSeconds?: number;
  clipSeconds?: number;
  videoSeconds?: number;
  hasVideo?: boolean;
  slot?: string;
  youtubeId?: string;
  uploadAttempts?: number;
  nextAttemptAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface Data {
  sources: Source[];
  clips: Clip[];
  drafts: Draft[];
}

export const newId = () => randomBytes(5).toString('hex');

export class Store {
  data: Data;

  constructor(private readonly file: string) {
    try {
      const d = JSON.parse(readFileSync(file, 'utf8'));
      this.data = { sources: d.sources ?? [], clips: d.clips ?? [], drafts: d.drafts ?? [] };
    } catch {
      this.data = { sources: [], clips: [], drafts: [] };
    }
  }

  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    renameSync(tmp, this.file);
  }

  source(id: string): Source {
    const s = this.data.sources.find((x) => x.id === id);
    if (!s) throw new Error('Kaynak bulunamadı');
    return s;
  }

  clip(key: string): Clip {
    const c = this.data.clips.find((x) => x.key === key);
    if (!c) throw new Error('Klip bulunamadı');
    return c;
  }

  draft(id: string): Draft {
    const d = this.data.drafts.find((x) => x.id === id);
    if (!d) throw new Error('Taslak bulunamadı');
    return d;
  }

  updateDraft(d: Draft, patch: Partial<Draft>): void {
    Object.assign(d, patch, { updatedAt: new Date().toISOString() });
    this.save();
  }
}
