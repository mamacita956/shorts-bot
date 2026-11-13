import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import { LANGUAGES } from './settings';
import { cleanText, fitTags } from './youtube';

export const ScriptSchema = z.object({
  hook: z.string().describe('On-screen headline: at most 6 words / 40 characters, no emoji'),
  narration: z.string().describe('The exact words the narrator speaks'),
  title: z.string().describe('YouTube title, at most 80 characters, no hashtags'),
  description: z.string().describe('One or two sentences plus 3-6 hashtags'),
  tags: z.array(z.string()).describe('5-12 short search tags without #'),
  coverText: z.string().describe('Thumbnail text: 2-4 punchy words, at most 24 characters, no emoji'),
  coverFrame: z.number().describe('Number (1-based) of the still that makes the most eye-catching thumbnail'),
});
export type Script = z.infer<typeof ScriptSchema>;

/** Speaking pace the word target is based on (energetic narration, ElevenLabs at speed 1.0). */
export const WORDS_PER_SECOND = 2.3;

export const targetWords = (seconds: number) => Math.max(8, Math.round((seconds - 1) * WORDS_PER_SECOND));

export interface ScriptRequest {
  language: string;
  style: string;
  seconds: number;
  clip: { title: string; description: string; hashtags: string; text: string; keywords: string[] };
  sourceNote: string;
  instructions: string;
  /** When rewriting: the version the user did not want, so the new one differs. */
  previous?: { hook: string; narration: string };
  /** When rewriting after the review panel turned the short down: the changes it asked for. */
  feedback?: string;
  /** What this channel's real results have taught so far. */
  lessons?: string[];
  /** Openings of this channel's best-performing shorts. */
  examples?: { hook: string; opening: string; views: number }[];
  frames: Buffer[];
}

/** Turns SDK errors into short Turkish messages for the panel. */
export function claudeError(e: unknown, model: string): Error {
  if (e instanceof Anthropic.AuthenticationError) return new Error('Claude API anahtarı geçersiz');
  if (e instanceof Anthropic.PermissionDeniedError || e instanceof Anthropic.NotFoundError) return new Error(`Bu Claude API anahtarı ${model} modelini kullanamıyor`);
  if (e instanceof Anthropic.RateLimitError) return new Error('Claude hız sınırına gelindi; biraz sonra tekrar dene');
  if (e instanceof Anthropic.BadRequestError) return new Error(`Claude isteği kabul etmedi: ${e.message}`);
  if (e instanceof Anthropic.APIConnectionError) return new Error('Claude sunucusuna bağlanılamadı');
  if (e instanceof Anthropic.APIError) return new Error(`Claude hatası ${e.status ?? ''}: ${e.message}`);
  return e as Error;
}

function systemPrompt(language: string, seconds: number, words: number): string {
  return [
    'You write voiceover scripts for vertical short videos (YouTube Shorts).',
    'You get still frames from a short clip (in order), what is said in the clip, its metadata, notes from the channel owner and the channel style.',
    `Write everything the viewer sees or hears in ${language}.`,
    '',
    'Fields:',
    `- narration: the exact words the narrator speaks over the clip. About ${words} words, so it fits ${seconds.toFixed(0)} seconds of speech. ` +
      'Spoken language only: no emojis, hashtags, stage directions, brackets or quotation marks. The first sentence must hook the viewer within two seconds. ' +
      'Follow what happens on screen, in order, and add the channel’s own take; do not read the original speech back word for word, it plays quietly under the voice.',
    '- hook: the headline shown at the top of the video, at most 6 words and 40 characters, no emoji. It should make people stop scrolling and not repeat the first sentence.',
    '- title: YouTube title up to 80 characters, may contain one emoji, no hashtags.',
    '- description: one or two sentences followed by 3-6 relevant hashtags.',
    '- tags: 5-12 short search tags without #.',
    '- coverText: the words on the thumbnail, 2-4 punchy words (at most 24 characters), no emoji; it may differ from the headline.',
    '- coverFrame: the number of the still (1 = first) that would make the most eye-catching thumbnail: clear action, a face or an emotional moment.',
    '',
    'Only state facts that the frames, the speech or the notes support. Do not invent names, scores, dates, records or quotes. ' +
      'If you are not sure who someone is, describe them instead of naming them.',
  ].join('\n');
}

function details(r: ScriptRequest, words: number): string {
  const lines = [
    `Channel style: ${r.style}`,
    `Clip length: ${r.seconds.toFixed(1)} seconds (target about ${words} words)`,
    `Frames: ${r.frames.length}, evenly spread through the clip`,
  ];
  if (r.clip.title) lines.push(`Clip title from OpusClip: ${r.clip.title}`);
  if (r.clip.description) lines.push(`Clip description from OpusClip: ${r.clip.description}`);
  if (r.clip.keywords.length) lines.push(`Keywords: ${r.clip.keywords.join(', ')}`);
  if (r.sourceNote) lines.push(`Owner's note about the source video: ${r.sourceNote}`);
  if (r.instructions) lines.push(`Owner's instructions for this clip: ${r.instructions}`);
  lines.push('', 'What is said in the clip:', r.clip.text ? `"""${r.clip.text}"""` : '(no speech)');
  if (r.previous?.narration) {
    lines.push('', 'This earlier version was turned down; write a clearly better one:', `Headline: ${r.previous.hook}`, `Narration: ${r.previous.narration}`);
  }
  if (r.feedback) lines.push('', 'Changes the review panel asked for (follow them):', r.feedback);
  if (r.lessons?.length) lines.push('', "What this channel's real results have shown so far (use it):", ...r.lessons.map((l) => `- ${l}`));
  if (r.examples?.length) {
    lines.push('', 'Openings of the channel’s most-watched shorts (for tone, do not copy):', ...r.examples.map((e) => `- ${e.views} views: [${e.hook}] ${e.opening}`));
  }
  return lines.join('\n');
}

function tidy(s: Script, frames: number): Script {
  const oneLine = (v: string) => v.replace(/\s+/g, ' ').trim();
  return {
    hook: oneLine(s.hook).slice(0, 60),
    narration: oneLine(s.narration.replace(/[*#_~`]/g, '')),
    title: cleanText(oneLine(s.title), 100),
    description: cleanText(s.description.trim(), 4000),
    tags: fitTags(s.tags),
    coverText: oneLine(s.coverText).slice(0, 30) || oneLine(s.hook).slice(0, 30),
    coverFrame: Math.min(Math.max(1, Math.round(s.coverFrame) || 1), Math.max(1, frames)),
  };
}

export class ScriptWriter {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
    baseURL?: string,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, ...(baseURL ? { baseURL } : {}) });
  }

  async write(r: ScriptRequest): Promise<Script> {
    const words = targetWords(r.seconds);
    const content: Anthropic.Beta.BetaContentBlockParam[] = [
      ...r.frames.map((f) => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: f.toString('base64') },
      })),
      { type: 'text' as const, text: details(r, words) },
    ];
    let msg;
    try {
      msg = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        // A policy decline on the requested model is retried server-side on its default fallback.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: systemPrompt(LANGUAGES[r.language] ?? r.language, r.seconds, words),
        messages: [{ role: 'user', content }],
        output_config: { effort: 'medium', format: betaZodOutputFormat(ScriptSchema) },
      });
    } catch (e) {
      throw claudeError(e, this.model);
    }
    if (msg.stop_reason === 'refusal') throw new Error('Claude bu klip için metin yazmadı (içerik politikası). Klibi atla ya da talimatı değiştir.');
    if (msg.stop_reason === 'max_tokens') throw new Error('Claude cevabı yarıda kesildi; tekrar dene');
    if (!msg.parsed_output) throw new Error('Claude geçerli bir cevap döndürmedi; tekrar dene');
    return tidy(msg.parsed_output, r.frames.length);
  }

  /** Confirms the key works and can use the chosen model, without generating anything. */
  async check(): Promise<void> {
    try {
      await this.client.models.retrieve(this.model);
    } catch (e) {
      throw claudeError(e, this.model);
    }
  }
}
