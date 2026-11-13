import { app, BrowserWindow, dialog, Menu, nativeImage, nativeTheme, Notification, shell, Tray } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const APP_ID = 'com.shortsbot.desktop';
/** Passed by the Windows startup entry: start in the tray without opening the window. */
const HIDDEN_ARG = '--hidden';

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let assetsDir = '';
let quitting = false;
let trayHintShown = false;
let shutdown = () => {};
let hasPendingWork = () => false;
let refreshTrayMenu = () => {};

const icon = (name: string) => join(assetsDir, name);

function showWindow(tab?: string) {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (tab) void win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(tab)}`);
}

function notify(title: string, body: string) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: icon('icon.png') });
  n.on('click', () => showWindow('drafts'));
  n.show();
}

/** Adds the app to Windows' startup list (it then starts hidden in the tray) or removes it. */
function applyStartAtLogin(on: boolean) {
  // A development run would register the bare electron.exe.
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: on, args: [HIDDEN_ARG] });
}

function quitApp() {
  if (win && hasPendingWork()) {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Çıkış', 'Vazgeç'],
      defaultId: 1,
      cancelId: 1,
      title: 'Shorts Bot',
      message: 'Yarım kalan bir iş var.',
      detail:
        'Hazırlanan ya da ajanların değerlendirdiği taslaklar veya YouTube’a yüklenmeyi bekleyen videolar var; uygulama kapalıyken bunlar ilerlemez.\n' +
        'YouTube’a zaten yüklenip zamanlanmış videolar yine saatinde yayınlanır.',
    });
    if (choice === 1) return;
  }
  quitting = true;
  app.quit();
}

function createTray(startAtLogin: () => boolean, setStartAtLogin: (on: boolean) => void) {
  tray = new Tray(nativeImage.createFromPath(icon('tray.png')));
  tray.setToolTip('Shorts Bot');
  refreshTrayMenu = () =>
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Shorts Bot’u aç', click: () => showWindow() },
        { label: 'Taslaklar', click: () => showWindow('drafts') },
        { type: 'separator' },
        { label: 'Windows açılınca başlat', type: 'checkbox', checked: startAtLogin(), click: (item) => setStartAtLogin(item.checked) },
        { type: 'separator' },
        { label: 'Çıkış', click: quitApp },
      ]),
    );
  refreshTrayMenu();
  tray.on('click', () => showWindow());
}

async function start() {
  // Installed app files are read-only, so settings, data and videos live in the user's profile
  // (%APPDATA%\Shorts Bot on Windows). In development they stay in the project folder.
  const home = app.isPackaged ? app.getPath('userData') : app.getAppPath();
  mkdirSync(home, { recursive: true });
  process.chdir(home);
  Menu.setApplicationMenu(null);
  app.setAppUserModelId(APP_ID);
  assetsDir = app.isPackaged ? join(process.resourcesPath, 'assets') : join(app.getAppPath(), 'assets');

  let url: string;
  try {
    const { setFfmpegPath } = await import('../ffmpeg');
    const { startRuntime } = await import('../runtime');
    const { startDashboard, dashboardHtml } = await import('../dashboard/server');
    if (app.isPackaged) setFfmpegPath(join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe'));
    const runtime = await startRuntime({
      home,
      assetsDir,
      notify,
      onSettingsSaved: (s) => {
        applyStartAtLogin(s.startAtLogin);
        refreshTrayMenu();
      },
    });
    applyStartAtLogin(runtime.settings.startAtLogin);
    const server = await startDashboard(runtime, {
      host: '127.0.0.1',
      port: 0,
      htmlPath: dashboardHtml(app.getAppPath()),
      openPath: (p) => void shell.openPath(p),
      pickFile: async () => {
        const opts: Electron.OpenDialogOptions = {
          title: 'Claude’un izleyeceği video dosyasını seç',
          properties: ['openFile'],
          filters: [
            { name: 'Video', extensions: ['mp4', 'm4v', 'mov', 'mkv', 'avi', 'webm', 'ts', 'mts', 'm2ts', 'wmv', 'flv', 'mpg', 'mpeg'] },
            { name: 'Tüm dosyalar', extensions: ['*'] },
          ],
        };
        const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
        return r.canceled ? null : (r.filePaths[0] ?? null);
      },
      desktop: true,
    });
    shutdown = () => {
      runtime.stop();
      server.close();
    };
    hasPendingWork = () => {
      const s = runtime.status();
      return Boolean(s.busy) || s.drafts.some((d) => ['queued', 'preparing', 'reviewing', 'approved'].includes(d.status));
    };
    createTray(
      () => runtime.settings.startAtLogin,
      (on) => void runtime.saveSettings({ startAtLogin: on }),
    );
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
    show: false,
    title: 'Shorts Bot',
    icon: icon('icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111110' : '#f4f3f0',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Started with Windows: stay in the tray until the user opens the window.
  if (!process.argv.includes(HIDDEN_ARG)) win.once('ready-to-show', () => win?.show());
  // Google's consent page and YouTube links open in the user's browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('https://')) void shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(url)) e.preventDefault();
  });
  // Closing the window keeps the app running in the tray; "Çıkış" in the tray menu quits.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win?.hide();
    if (!trayHintShown) {
      trayHintShown = true;
      notify('Shorts Bot arka planda çalışıyor', 'Kapatmak için saatin yanındaki simgeye sağ tıklayıp Çıkış’ı seç.');
    }
  });
  win.on('closed', () => (win = null));
  await win.loadURL(url);
}

// Two copies would prepare and upload the same videos twice.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.on('before-quit', () => {
    quitting = true;
    shutdown();
  });
  app.on('window-all-closed', () => {
    if (quitting) app.quit();
  });
  app.whenReady().then(start);
}
