const { app, BrowserWindow, Menu, protocol } = require('electron');
const path = require('path');

const { registerAudioHandlers, releaseAudio } = require('./electron/audio-ipc.cjs');
const { registerChartHandlers } = require('./electron/chart-ipc.cjs');
const skin = require('./electron/skin.cjs');
const appProtocol = require('./electron/app-protocol.cjs');

// Chromium throttles rAF and timers in windows that do not have focus. In a rhythm game
// that desynchronises the picture from the audio the moment the player alt-tabs away.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// Every custom scheme has to be declared before the app is ready, in a **single** call.
//
// `registerSchemesAsPrivileged` replaces whatever was registered before rather than adding
// to it, so calling it once per scheme leaves every scheme but the last one unprivileged.
// That failure is entirely silent and expensive: `app://` lost `secure: true`, which made
// the whole renderer a non-secure context, which removed `navigator.gpu`, which sent Pixi
// to WebGL for the whole session with nothing logged anywhere.
protocol.registerSchemesAsPrivileged([appProtocol.SCHEME, skin.SCHEME]);

/** Set when running against the vite dev server instead of a production build. */
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    // Avoids the white flash: shown once the first frame is ready to paint.
    show: false,
    backgroundColor: '#101014',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload script needs `require` for relative modules, which the renderer
      // sandbox does not provide. Disabling it applies to the preload only: the page
      // itself still has no Node access, and contextIsolation keeps preload internals
      // out of its reach. Safe here because the window only ever loads local content.
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // The default menu is gone, so devtools needs a way back. A raw key check rather than an
  // accelerator, because an accelerator is exactly the thing being removed.
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools();
    }
  });

  if (DEV_SERVER_URL) {
    win.loadURL(DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    // Served rather than loaded from disk, so the page has a real origin.
    win.loadURL(appProtocol.APP_URL);
  }

  return win;
}

app.whenReady().then(() => {
  // No application menu at all.
  //
  // Electron installs a default one, and every item on it carries an accelerator that is
  // live during play: Alt opens the File menu, Ctrl+R reloads mid-song, Ctrl+W closes the
  // window. A lane layout that uses those modifiers hits them by accident, and a rhythm
  // game cannot afford a keypress to open a menu instead of playing a note.
  Menu.setApplicationMenu(null);

  appProtocol.serveApp();
  skin.serveSkinFiles();
  registerAudioHandlers();
  registerChartHandlers();
  createWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', releaseAudio);
