import { join, resolve } from 'node:path';

export interface Paths {
  home: string;
  settingsFile: string;
  storeFile: string;
  tokenFile: string;
  clipsDir: string;
  draftsDir: string;
  musicDir: string;
  fontsDir: string;
}

/** Everything the app writes lives under one folder (%APPDATA%\Shorts Bot when installed). */
export function pathsFor(home: string): Paths {
  const h = resolve(home);
  return {
    home: h,
    settingsFile: join(h, 'settings.json'),
    storeFile: join(h, 'data', 'store.json'),
    tokenFile: join(h, 'data', 'youtube.json'),
    clipsDir: join(h, 'media', 'clips'),
    draftsDir: join(h, 'media', 'drafts'),
    musicDir: join(h, 'music'),
    fontsDir: join(h, 'fonts'),
  };
}

export const safeName = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');
