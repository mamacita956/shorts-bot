import { app, BrowserWindow, dialog, Menu, nativeTheme, shell } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

let win: BrowserWindow | null = null;
let quitting = false;
let shutdown = () => {};
let hasPendingWork = () => false;

function focusWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
}

async function start() {
  // Installed app files are read-only, so settings, data and videos live in the user's profile
  // (%APPDATA%\Shorts Bot on Windows). In development they stay in the project folder.
  const home = app.isPackaged ? app.getPath('userData') : app.getAppPath();
  mkdirSync(home, { recursive: true });
  process.chdir(home);
  Menu.setApplicationMenu(null);

  let url: string;
  try {
    const { setFfmpegPath } = await import('../ffmpeg');
    const { startRuntime } = await import('../runtime');
    const { startDashboard, dashboardHtml } = await import('../dashboard/server');
    if (app.isPackaged) setFfmpegPath(join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe'));
    const assetsDir = app.isPackaged ? join(process.resourcesPath, 'assets') : join(app.getAppPath(), 'assets');
    const runtime = await startRuntime({ home, assetsDir });
    const server = await startDashboard(runtime, {
      host: '127.0.0.1',
      port: 0,
      htmlPath: dashboardHtml(app.getAppPath()),
      openPath: (p) => void shell.openPath(p),
    });
    shutdown = () => {
      runtime.stop();
      server.close();
    };
    hasPendingWork = () => {
      const s = runtime.status();
      return Boolean(s.busy) || s.drafts.some((d) => d.status === 'approved' || d.status === 'queued');
    };
    url = `http://127.0.0.1:${server.port}/`;
  } catch (e) {
    dialog.showErrorBox('Shorts Bot başlatılamadı', `${(e as Error).message}\n\nVeri klasörü: ${home}`);
    app.quit();
    return;
  }

  win = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Shorts Bot',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111110' : '#f4f3f0',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Google's consent page and YouTube links open in the user's browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('https://')) void shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(url)) e.preventDefault();
  });
  win.on('close', (e) => {
    if (quitting || !win || !hasPendingWork()) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Kapat', 'Vazgeç'],
      defaultId: 1,
      cancelId: 1,
      title: 'Shorts Bot',
      message: 'Yarım kalan bir iş var.',
      detail:
        'Hazırlanan taslaklar ya da YouTube’a yüklenmeyi bekleyen onaylı videolar var; uygulama kapalıyken bunlar ilerlemez.\n' +
        'YouTube’a zaten yüklenip zamanlanmış videolar yine saatinde yayınlanır.',
    });
    if (choice === 1) e.preventDefault();
    else quitting = true;
  });
  win.on('closed', () => (win = null));
  await win.loadURL(url);
}

// Two copies would prepare and upload the same videos twice.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', focusWindow);
  app.on('window-all-closed', () => {
    shutdown();
    app.quit();
  });
  app.whenReady().then(start);
}
