const { app, BrowserWindow } = require('electron');
const path = require('path');

const { registerAudioHandlers, releaseAudio } = require('./electron/audio-ipc.cjs');
const { registerChartHandlers } = require('./electron/chart-ipc.cjs');

// Chromium throttles rAF and timers in windows that do not have focus. In a rhythm game
// that desynchronises the picture from the audio the moment the player alt-tabs away.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

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

  if (DEV_SERVER_URL) {
    win.loadURL(DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }

  return win;
}

app.whenReady().then(() => {
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
