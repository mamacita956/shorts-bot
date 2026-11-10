export type LogLevel = 'info' | 'warn' | 'error' | 'ok';

export interface LogEntry {
  time: string;
  level: LogLevel;
  msg: string;
}

const MAX_RECENT = 400;
const recent: LogEntry[] = [];
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const PREFIX: Record<LogLevel, string> = { info: '', warn: 'UYARI: ', error: 'HATA: ', ok: '>>> ' };

function write(level: LogLevel, msg: string) {
  recent.push({ time: new Date().toISOString(), level, msg });
  if (recent.length > MAX_RECENT) recent.shift();
  const line = `[${ts()}] ${PREFIX[level]}${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  info: (msg: string) => write('info', msg),
  warn: (msg: string) => write('warn', msg),
  error: (msg: string) => write('error', msg),
  ok: (msg: string) => write('ok', msg),
  recent: (): LogEntry[] => [...recent],
};
