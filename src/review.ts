import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import { claudeError } from './claude';
import { LANGUAGES } from './settings';

export interface Reviewer {
  id: string;
  name: string;
  role: string;
  focus: string;
}

export const REVIEWERS: Reviewer[] = [
  {
    id: 'viewer',
    name: 'İzleyici',
    role: 'a typical viewer scrolling through YouTube Shorts in the channel’s niche',
    focus:
      'Do the headline and the first sentence stop the scroll within two seconds? Is the pacing tight? ' +
      'Would you watch to the end, like, comment or share? Is anything boring, confusing, too long or cringe?',
  },
  {
    id: 'editor',
    name: 'Editör',
    role: 'the channel’s editor, responsible for accuracy and craft',
    focus:
      'Does the narration match what is on screen? Are there names, scores, dates or claims the frames, the speech or the notes do not support? ' +
      'Is the language natural, with no grammar or spelling mistakes? Are the burned-in headline and captions readable and well placed? ' +
      'Are the title, description and tags accurate and well written?',
  },
  {
    id: 'manager',
    name: 'Kanal yöneticisi',
    role: 'the channel manager, responsible for growth and for keeping the channel in good standing',
    focus:
      'Does it fit the channel’s style and audience? Does the narration add real commentary of its own, or does it mostly re-show someone else’s footage ' +
      '(YouTube’s reused-content rules)? Does the title promise something the video does not deliver? ' +
      'Is there anything that could hurt the channel: hateful, sexual, shocking or graphic content, or claims that could be defamatory?',
  },
];

const OpinionSchema = z.object({
  score: z.number().describe('1-10: 9-10 excellent, 7-8 good enough to publish, 5-6 needs changes, 1-4 should not be published'),
  verdict: z.enum(['approve', 'reject']),
  comment: z.string().describe('2-4 sentences with your main reasons; in round 2, answer the other reviewers'),
  fix: z.string().describe('Concrete changes that would make it publishable, or an empty string'),
});

export interface Opinion {
  reviewer: string;
  name: string;
  round: 1 | 2;
  score: number;
  verdict: 'approve' | 'reject';
  comment: string;
  fix: string;
}

export interface Review {
  verdict: 'approve' | 'reject';
  /** Average of the final-round scores. */
  score: number;
  approvals: number;
  opinions: Opinion[];
  /** What the reviewers who said no want changed; handed to Claude when the short is rewritten. */
  feedback: string;
  at: string;
}

export interface ReviewInput {
  language: string;
  style: string;
  /** Stills from the finished video, with its headline and captions burned in. */
  frames: Buffer[];
  draft: { hook: string; narration: string; title: string; description: string; tags: string[]; coverText?: string };
  clip: { rank: number; seconds: number; text: string };
  videoSeconds: number;
  sourceNote: string;
  minScore: number;
  /** Lessons drawn from this channel's real results. */
  lessons?: string[];
  /** Recent published shorts: the panel's score next to the views they actually got. */
  track?: { title: string; panelScore?: number; views: number; earlyViews?: number; hoursLive: number }[];
}

function systemPrompt(language: string): string {
  return [
    'You sit on the three-member review panel of a YouTube Shorts channel. The panel decides whether a finished short is published.',
    'You see stills from the finished video (with its burned-in headline and captions), the narration, the YouTube title, description and tags, and what is said in the original clip.',
    `Write your comment and fix in ${language}.`,
    'Be specific and honest. Approve only what you would be glad to see on the channel today; reject if it needs changes first.',
    'When the channel’s real results are included, judge with them: they show what this audience actually watches, and whether the panel’s past scores matched the views.',
  ].join('\n');
}

function shared(r: ReviewInput): string {
  return [
    `Channel style: ${r.style}`,
    r.sourceNote ? `Owner's note about the source video: ${r.sourceNote}` : '',
    `OpusClip rank: #${r.clip.rank} (OpusClip's own virality ranking within its source video)`,
    `Video length: ${r.videoSeconds.toFixed(0)} s (original clip ${r.clip.seconds.toFixed(0)} s)`,
    `Stills: ${r.frames.length}, evenly spread through the video`,
    '',
    `Headline on screen: ${r.draft.hook}`,
    `Narration: ${r.draft.narration}`,
    `YouTube title: ${r.draft.title}`,
    `Description: ${r.draft.description}`,
    `Tags: ${r.draft.tags.join(', ')}`,
    r.draft.coverText ? `Thumbnail text (big capitals on a clean frame): ${r.draft.coverText}` : '',
    '',
    'What is said in the original clip (plays quietly under the narration):',
    r.clip.text ? `"""${r.clip.text}"""` : '(no speech)',
    ...(r.lessons?.length ? ['', "Lessons from this channel's real results:", ...r.lessons.map((l) => `- ${l}`)] : []),
    ...(r.track?.length
      ? [
          '',
          'Recent shorts on this channel - panel score vs. what they got:',
          ...r.track.map(
            (t) =>
              `- "${t.title}": panel ${t.panelScore ?? '-'}/10, ${t.views} views${t.earlyViews !== undefined ? ` (${t.earlyViews} at 48 h)` : ''}, live ${Math.round(t.hoursLive)} h`,
          ),
        ]
      : []),
  ]
    .filter((l) => l !== '')
    .join('\n');
}

function roleText(who: Reviewer, others?: Opinion[], mine?: Opinion): string {
  const lines = [`Your role: ${who.role}.`, `Focus on: ${who.focus}`];
  if (!others) {
    lines.push('This is round 1: give your own, independent judgement.');
  } else {
    lines.push(
      '',
      'This is round 2. The other reviewers said in round 1:',
      ...others.map((o) => `- ${o.name}: ${o.score}/10, ${o.verdict === 'approve' ? 'approve' : 'reject'}. ${o.comment}${o.fix ? ` Fix: ${o.fix}` : ''}`),
      '',
      `Your round-1 view: ${mine?.score}/10, ${mine?.verdict}. ${mine?.comment}`,
      'Answer their points: agree or push back, then give your final score and verdict. Change your mind only if their argument convinced you, not just to agree.',
    );
  }
  return lines.join('\n');
}

/** Majority of the final round approves and the average score reaches the bar. */
export function decide(finalRound: Opinion[], minScore: number): Pick<Review, 'verdict' | 'score' | 'approvals' | 'feedback'> {
  const approvals = finalRound.filter((o) => o.verdict === 'approve').length;
  const score = finalRound.reduce((n, o) => n + o.score, 0) / Math.max(1, finalRound.length);
  const verdict = approvals * 2 > finalRound.length && score >= minScore ? 'approve' : 'reject';
  const feedback = finalRound
    .filter((o) => o.fix.trim() && (o.verdict === 'reject' || verdict === 'reject'))
    .map((o) => `${o.name}: ${o.fix.trim()}`)
    .join('\n');
  return { verdict, score: Math.round(score * 10) / 10, approvals, feedback };
}

export class ReviewPanel {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
    baseURL?: string,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, ...(baseURL ? { baseURL } : {}) });
  }

  private async ask(r: ReviewInput, who: Reviewer, round: 1 | 2, others?: Opinion[], mine?: Opinion): Promise<Opinion> {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [
      ...r.frames.map((f) => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: f.toString('base64') },
      })),
      // Everything up to here is the same for every reviewer and both rounds, so it can be cached.
      { type: 'text' as const, text: shared(r), cache_control: { type: 'ephemeral' as const } },
      { type: 'text' as const, text: roleText(who, others, mine) },
    ];
    let msg;
    try {
      msg = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: systemPrompt(LANGUAGES[r.language] ?? r.language),
        messages: [{ role: 'user', content }],
        output_config: { effort: 'medium', format: betaZodOutputFormat(OpinionSchema) },
      });
    } catch (e) {
      throw claudeError(e, this.model);
    }
    const base = { reviewer: who.id, name: who.name, round };
    // A reviewer that will not or cannot judge the short counts as a no, so nothing is published unchecked.
    if (msg.stop_reason === 'refusal') return { ...base, score: 0, verdict: 'reject', comment: 'Bu videoyu değerlendirmedi (içerik politikası).', fix: '' };
    const o = msg.parsed_output;
    if (msg.stop_reason === 'max_tokens' || !o) return { ...base, score: 0, verdict: 'reject', comment: 'Geçerli bir değerlendirme döndürmedi.', fix: '' };
    return { ...base, score: Math.min(10, Math.max(0, Math.round(o.score))), verdict: o.verdict, comment: o.comment.trim(), fix: o.fix.trim() };
  }

  async review(r: ReviewInput): Promise<Review> {
    const first = await Promise.all(REVIEWERS.map((who) => this.ask(r, who, 1)));
    const second = await Promise.all(
      REVIEWERS.map((who, i) =>
        this.ask(
          r,
          who,
          2,
          first.filter((_, j) => j !== i),
          first[i],
        ),
      ),
    );
    return { ...decide(second, r.minScore), opinions: [...first, ...second], at: new Date().toISOString() };
  }
}
