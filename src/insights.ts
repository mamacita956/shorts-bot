import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import { claudeError } from './claude';
import { LANGUAGES } from './settings';

/** One published short and how it has done so far. */
export interface Result {
  title: string;
  hook: string;
  /** First sentence of the narration. */
  opening: string;
  seconds: number;
  opusRank: number;
  /** Average review-panel score, if the panel saw it. */
  panelScore?: number;
  views: number;
  likes: number;
  comments: number;
  hoursLive: number;
  /** Views at the first check after 48 hours live (the fairest comparison between shorts). */
  earlyViews?: number;
  publishedAt: string;
}

export interface Insights {
  lessons: string[];
  /** How many published shorts the lessons were drawn from. */
  basedOn: number;
  at: string;
}

const LessonsSchema = z.object({
  lessons: z.array(z.string()).describe('3-8 short, concrete lessons, each one sentence'),
});

export const firstSentence = (text: string) => (/^.*?[.!?…](\s|$)/.exec(text.trim())?.[0] ?? text).trim().slice(0, 200);

function table(rows: Result[]): string {
  return rows
    .map(
      (r, i) =>
        `${i + 1}. "${r.title}" | headline: ${r.hook} | opening: ${r.opening} | ${r.seconds.toFixed(0)} s | OpusClip #${r.opusRank}` +
        ` | panel ${r.panelScore ?? '-'}/10 | views ${r.views}${r.earlyViews !== undefined ? ` (${r.earlyViews} at 48 h)` : ''}` +
        ` | likes ${r.likes} | comments ${r.comments} | live ${Math.round(r.hoursLive)} h | published ${r.publishedAt.slice(0, 16)}`,
    )
    .join('\n');
}

/** Turns the channel's real numbers into lessons the script writer and the review panel can use. */
export class LessonWriter {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
    baseURL?: string,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, ...(baseURL ? { baseURL } : {}) });
  }

  async write(rows: Result[], language: string, style: string): Promise<string[]> {
    const system = [
      'You analyse the results of a YouTube Shorts channel to find out what its audience responds to.',
      `Write the lessons in ${LANGUAGES[language] ?? language}.`,
      'Each lesson is one short, concrete sentence the script writer or the review panel can act on (for example about openings, headlines, length, topics, or how well the panel’s scores matched the views).',
      'Base every lesson on the numbers. Compare shorts that have been live for a similar time; views at 48 hours are the fairest comparison. ' +
        'With little data, say the pattern is still weak instead of overstating it. Do not invent numbers.',
    ].join('\n');
    let msg;
    try {
      msg = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system,
        messages: [{ role: 'user', content: `Channel style: ${style}\n\nPublished shorts (${rows.length}):\n${table(rows)}` }],
        output_config: { effort: 'medium', format: betaZodOutputFormat(LessonsSchema) },
      });
    } catch (e) {
      throw claudeError(e, this.model);
    }
    if (msg.stop_reason === 'refusal' || !msg.parsed_output) throw new Error('Claude sonuçlardan ders çıkaramadı; daha sonra tekrar denenecek');
    return msg.parsed_output.lessons.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 8);
  }
}
