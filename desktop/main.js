const { app, BrowserWindow, session, desktopCapturer, shell } = require('electron');

// ← غيّر الرابط لرابط سيرفرك بعد ما ترفعه (مثال Render)
const SITE = 'https://samar.onrender.com';

let win;
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

  function createWindow() {
    win = new BrowserWindow({
      width: 1200, height: 800, title: 'Samar',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    win.loadURL(SITE);
    win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  }

  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((wc, perm, cb) =>
      cb(['media', 'display-capture', 'notifications'].includes(perm)));

    session.defaultSession.setDisplayMediaRequestHandler(async (req, cb) => {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      cb({ video: sources[0], audio: 'loopback' });
    });

    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
