import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Insights } from './insights';
import type { Review } from './review';

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

export type DraftStatus = 'queued' | 'preparing' | 'reviewing' | 'ready' | 'failed' | 'approved' | 'uploading' | 'scheduled' | 'rejected';
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
  /** The review panel's latest debate and decision. */
  review?: Review;
  /** How many times the panel's feedback has been used to rewrite this short. */
  revisions?: number;
  /** Words on the thumbnail, and where in the clip its frame is taken. */
  coverText?: string;
  coverAt?: number;
  hasCover?: boolean;
  thumbnailSet?: boolean;
  /** Why the thumbnail cannot be set (e.g. the channel is not verified); no more attempts. */
  thumbnailError?: string;
  thumbnailAttempts?: number;
  nextThumbAt?: string;
  /** Latest public counts from YouTube. */
  stats?: { views: number; likes: number; comments: number; checkedAt: string };
  /** Counts at the first check after 48 hours live. */
  early?: { views: number; likes: number; comments: number; hoursLive: number };
  /** YouTube rejected or failed the video. */
  ytProblem?: string;
  createdAt: string;
  updatedAt: string;
}

interface Data {
  sources: Source[];
  clips: Clip[];
  drafts: Draft[];
  insights?: Insights;
  statsCheckedAt?: string;
}

export const newId = () => randomBytes(5).toString('hex');

export class Store {
  data: Data;

  constructor(private readonly file: string) {
    try {
      const d = JSON.parse(readFileSync(file, 'utf8'));
      this.data = { sources: d.sources ?? [], clips: d.clips ?? [], drafts: d.drafts ?? [], insights: d.insights, statsCheckedAt: d.statsCheckedAt };
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
