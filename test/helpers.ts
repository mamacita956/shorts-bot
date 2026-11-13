import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Alignment } from '../src/eleven';
import { runFfmpeg } from '../src/ffmpeg';

export interface Fake {
  url: string;
  close: () => Promise<void>;
}

export async function serve(handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => unknown): Promise<Fake> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    try {
      await handler(req, res, Buffer.concat(chunks));
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

export const tempDir = (name: string) => mkdtempSync(join(tmpdir(), `shorts-${name}-`));

export async function makeClip(file: string, seconds: number, size = '1080x1920') {
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30`, '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
    '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file,
  ]);
}

/** Landscape "match footage": quiet, then loud between 18 and 24 seconds (the crowd at a goal). */
export async function makeMatch(file: string, seconds = 40) {
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-filter_complex', "[1:a]volume='if(between(t,18,24),1,0.05)':eval=frame[a]", '-map', '0:v', '-map', '[a]',
    '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file,
  ]);
}

export async function makeTone(file: string, seconds: number) {
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100', '-t', seconds.toFixed(2), '-c:a', 'libmp3lame', '-b:a', '64k', file]);
}

/** Character timings for `text` read at a steady pace, shaped like ElevenLabs' alignment. */
export function fakeAlignment(text: string, perChar = 0.05): Alignment {
  const characters = [...text];
  return {
    characters,
    character_start_times_seconds: characters.map((_, i) => +(i * perChar).toFixed(3)),
    character_end_times_seconds: characters.map((_, i) => +((i + 1) * perChar).toFixed(3)),
  };
}

export const SCRIPT = {
  hook: 'Bu gol tarihe geçti',
  narration: 'Bu golü gördünüz mü? Top ceza sahasında, bir dokunuş ve ağlar havalanıyor! Sizce sezonun golü mü?',
  title: 'Sezonun golü bu mu? ⚽',
  description: 'Bu pozisyonu kaçırmayın. #futbol #gol #shorts',
  tags: ['futbol', 'gol', 'süper lig', '#derbi'],
  coverText: 'istanbul sallandı',
  coverFrame: 2,
};

export const LESSONS = ['Soruyla başlayan girişler daha çok izlendi.', 'Ajan puanı 8 ve üstü olan videolar 48 saatte daha iyi gitti.'];

export interface Opinion {
  score: number;
  verdict: 'approve' | 'reject';
  comment: string;
  fix: string;
}

export interface Recorded {
  opusCreate: Record<string, unknown>[];
  /** Script-writing requests. */
  claude: Record<string, unknown>[];
  /** Review-panel requests (their output schema asks for a verdict). */
  reviews: Record<string, unknown>[];
  claudeHeaders: IncomingMessage['headers'][];
  eleven: Record<string, unknown>[];
  uploadInit: Record<string, unknown>[];
  uploadHeaders: IncomingMessage['headers'][];
  uploaded: Buffer[];
  tokenRequests: URLSearchParams[];
  /** Requests that asked Claude for channel lessons. */
  lessons: Record<string, unknown>[];
  thumbnails: { videoId: string; type: string; body: Buffer }[];
  videoLookups: string[];
  /** Speech-to-text uploads: the form fields and the audio size. */
  stt: { fields: Record<string, string>; bytes: number }[];
  /** Clip-agent requests: stage 1 (candidates) and stage 2 (final clips). */
  finder: { stage: 1 | 2; body: Record<string, unknown> }[];
}

/** What the fake speech-to-text hears in the match video. */
export const HEARD = [
  { text: 'Top', type: 'word', start: 3.0, end: 3.3 },
  { text: ' ', type: 'spacing', start: 3.3, end: 3.4 },
  { text: 'orta', type: 'word', start: 3.4, end: 3.8 },
  { text: 'sahada.', type: 'word', start: 3.9, end: 4.5 },
  { text: 'Ceza', type: 'word', start: 17.0, end: 17.4 },
  { text: 'sahasına', type: 'word', start: 17.5, end: 18.2 },
  { text: 'giriyor', type: 'word', start: 18.3, end: 18.9 },
  { text: 've', type: 'word', start: 19.0, end: 19.2 },
  { text: 'GOOOL!', type: 'word', start: 19.3, end: 21.0 },
  { text: '(cheering)', type: 'audio_event', start: 19.5, end: 24.0 },
];

/** Fake OpusClip, ElevenLabs, Claude and Google endpoints backed by real media files. */
export async function startFakes(dir: string, clipSeconds = 6) {
  const clip = join(dir, 'source-clip.mp4');
  await makeClip(clip, clipSeconds);
  const rec: Recorded = {
    opusCreate: [], claude: [], reviews: [], claudeHeaders: [], eleven: [], uploadInit: [], uploadHeaders: [], uploaded: [], tokenRequests: [],
    lessons: [], thumbnails: [], videoLookups: [], stt: [], finder: [],
  };
  // What the clip agent answers in its two stages; the test can change it.
  const agent = {
    candidates: [
      { start: 14, end: 30, title: 'Son dakika golü', why: 'Ses 18. saniyede yükseliyor, spiker GOOOL diye bağırıyor.' },
      { start: 1, end: 9, title: 'Orta saha', why: 'Sakin bir an.' },
    ],
    clips: [
      { candidate: 1, start: 15, end: 27, score: 91, title: 'Ağları sarsan gol', reason: 'Atak, gol ve tribünün coşkusu tek klipte.' },
      { candidate: 2, start: 1, end: 12, score: 38, title: 'Orta sahada pas', reason: 'Zayıf ama yedek olarak dursun.' },
    ],
  };
  // What the fake YouTube reports about uploaded videos; the test can change it.
  const yt = {
    processing: 'succeeded',
    thumbnailStatus: 200,
    videos: new Map<string, { views: number; likes: number; comments: number; uploadStatus: string; privacy: string; rejectionReason?: string }>(),
  };
  // What each reviewer answers; the test can swap it. The argument counts review requests so far (0-based).
  const panel = { opinion: (_n: number): Opinion => ({ score: 8, verdict: 'approve', comment: 'İyi bir video.', fix: '' }) };
  let projectChecks = 0;
  let toneN = 0;

  const opus: Fake = await serve(async (req, res, body) => {
    const url = new URL(req.url ?? '/', 'http://x');
    // Clip files come from OpusClip's CDN, which needs no key.
    if (url.pathname === '/media/clip.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      return res.end(await readFile(clip));
    }
    if (req.headers.authorization !== 'Bearer opus-key') return sendJson(res, 401, { message: 'bad key' });
    if (req.method === 'POST' && url.pathname === '/api/clip-projects') {
      rec.opusCreate.push(JSON.parse(body.toString()));
      return sendJson(res, 201, { id: 'P1', projectId: 'P1', stage: 'QUEUED' });
    }
    if (url.pathname === '/api/clip-projects/P1') return sendJson(res, 200, { id: 'P1', stage: ++projectChecks >= 2 ? 'COMPLETE' : 'CURATE', error: null });
    if (url.pathname === '/api/exportable-clips') {
      const page = Number(url.searchParams.get('pageNum'));
      const items = page === 1
        ? [1, 2].map((n) => ({
          id: `P1.CU${n}`, projectId: 'P1', curationId: `CU${n}`, title: `Klip ${n}`, description: 'Açıklama', hashtags: '#a', text: 'What a goal by the striker',
          durationMs: clipSeconds * 1000, keywords: ['goal'], uriForPreview: `${opus.url}/media/clip.mp4`, uriForExport: `${opus.url}/media/clip.mp4`,
        }))
        : [];
      return sendJson(res, 200, items);
    }
    sendJson(res, 404, { message: 'not found' });
  });

  const eleven: Fake = await serve(async (req, res, body) => {
    if (req.headers['xi-api-key'] !== 'el-key') return sendJson(res, 401, { detail: { message: 'invalid key' } });
    if (req.method === 'POST' && /\/v1\/text-to-speech\/V1\/with-timestamps/.test(req.url ?? '')) {
      const b = JSON.parse(body.toString());
      rec.eleven.push(b);
      const alignment = fakeAlignment(b.text);
      const tone = join(dir, `tone${++toneN}.mp3`);
      await makeTone(tone, alignment.character_end_times_seconds.at(-1) ?? 1);
      return sendJson(res, 200, { audio_base64: (await readFile(tone)).toString('base64'), alignment, normalized_alignment: alignment });
    }
    if (req.method === 'POST' && req.url?.startsWith('/v1/speech-to-text')) {
      const text = body.toString('latin1');
      const fields: Record<string, string> = {};
      for (const m of text.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)\r\n/g)) fields[m[1]] = m[2];
      const file = /name="file"; filename="[^"]*"\r\nContent-Type: [^\r]*\r\n\r\n/.exec(text);
      rec.stt.push({ fields, bytes: file ? body.length - (file.index + file[0].length) : 0 });
      return sendJson(res, 200, { language_code: 'tur', language_probability: 0.98, text: 'Top orta sahada. Ceza sahasına giriyor ve GOOOL!', words: HEARD });
    }
    if (req.url?.startsWith('/v2/voices')) {
      return sendJson(res, 200, { voices: [{ voice_id: 'V1', name: 'Ahmet', category: 'premade', labels: { gender: 'male', language: 'tr' }, preview_url: null }], has_more: false, total_count: 1 });
    }
    sendJson(res, 404, { detail: 'not found' });
  });

  const claude: Fake = await serve((req, res, body) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) return sendJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'nope' } });
    const b = JSON.parse(body.toString());
    rec.claudeHeaders.push(req.headers);
    const props = b.output_config?.format?.schema?.properties ?? {};
    let answer: unknown = SCRIPT;
    if (props.candidates || props.clips) {
      rec.finder.push({ stage: props.candidates ? 1 : 2, body: b });
      answer = props.candidates ? { candidates: agent.candidates } : { clips: agent.clips };
    } else if (props.verdict) {
      answer = panel.opinion(rec.reviews.length);
      rec.reviews.push(b);
    } else if (props.lessons) {
      answer = { lessons: LESSONS };
      rec.lessons.push(b);
    } else {
      rec.claude.push(b);
    }
    sendJson(res, 200, {
      id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
      content: [{ type: 'text', text: JSON.stringify(answer) }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 50 },
    });
  });

  let received: Buffer = Buffer.alloc(0);
  let failFirstPut = true;
  const google: Fake = await serve((req, res, body) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/token') {
      const q = new URLSearchParams(body.toString());
      rec.tokenRequests.push(q);
      if (q.get('grant_type') === 'authorization_code') return sendJson(res, 200, { access_token: 'AT1', expires_in: 3600, refresh_token: 'RT1' });
      return sendJson(res, 200, { access_token: 'AT2', expires_in: 3600 });
    }
    if (url.pathname === '/youtube/v3/channels') return sendJson(res, 200, { items: [{ id: 'UC1', snippet: { title: 'Test Kanal' } }] });
    if (req.method === 'GET' && url.pathname === '/youtube/v3/videos') {
      if (req.headers.authorization !== 'Bearer AT1' && req.headers.authorization !== 'Bearer AT2') return sendJson(res, 401, { error: { message: 'no token' } });
      const ids = (url.searchParams.get('id') ?? '').split(',');
      const part = url.searchParams.get('part') ?? '';
      rec.videoLookups.push(part);
      if (part === 'processingDetails') return sendJson(res, 200, { items: ids.map((id) => ({ id, processingDetails: { processingStatus: yt.processing } })) });
      const items = ids.flatMap((id) => {
        const v = yt.videos.get(id);
        if (!v) return [];
        return [{
          id,
          statistics: { viewCount: String(v.views), likeCount: String(v.likes), commentCount: String(v.comments) },
          status: { uploadStatus: v.uploadStatus, privacyStatus: v.privacy, ...(v.rejectionReason ? { rejectionReason: v.rejectionReason } : {}) },
        }];
      });
      return sendJson(res, 200, { items });
    }
    if (req.method === 'POST' && url.pathname === '/upload/youtube/v3/thumbnails/set') {
      if (yt.thumbnailStatus !== 200) return sendJson(res, yt.thumbnailStatus, { error: { code: yt.thumbnailStatus, message: 'The authenticated user doesnt have permissions to upload and set custom video thumbnails.' } });
      rec.thumbnails.push({ videoId: url.searchParams.get('videoId') ?? '', type: String(req.headers['content-type']), body });
      return sendJson(res, 200, { items: [{ default: { url: 'https://i.ytimg.com/vi/x/default.jpg' } }] });
    }
    if (req.method === 'POST' && url.pathname === '/upload/youtube/v3/videos') {
      rec.uploadInit.push(JSON.parse(body.toString()));
      rec.uploadHeaders.push(req.headers);
      received = Buffer.alloc(0);
      res.writeHead(200, { Location: `${google.url}/session/1` });
      return res.end();
    }
    if (req.method === 'PUT' && url.pathname === '/session/1') {
      const range = String(req.headers['content-range'] ?? '');
      if (range.startsWith('bytes */')) {
        res.writeHead(308, received.length ? { Range: `bytes=0-${received.length - 1}` } : {});
        return res.end();
      }
      if (failFirstPut) {
        // Pretend the connection dropped halfway through.
        failFirstPut = false;
        received = body.subarray(0, Math.floor(body.length / 2));
        res.writeHead(503);
        return res.end();
      }
      received = Buffer.concat([received, body]);
      rec.uploaded.push(received);
      return sendJson(res, 200, { id: `VID${rec.uploaded.length}`, status: { privacyStatus: 'private' } });
    }
    sendJson(res, 404, { error: { message: 'not found' } });
  });

  return {
    rec,
    panel,
    yt,
    agent,
    clip,
    endpoints: { opus: opus.url, eleven: eleven.url, claude: claude.url },
    google: { auth: `${google.url}/auth`, token: `${google.url}/token`, api: `${google.url}/youtube/v3`, upload: `${google.url}/upload/youtube/v3` },
    close: async () => {
      await Promise.all([opus.close(), eleven.close(), claude.close(), google.close()]);
    },
  };
}
