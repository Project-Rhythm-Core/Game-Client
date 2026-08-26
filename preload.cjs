const { contextBridge, ipcRenderer } = require('electron');

const { CHANNEL } = require('./electron/audio-channels.cjs');

// Mirrors the audio IPC surface into the renderer. Everything returns a promise,
// including the void operations, because it all crosses ipcRenderer.invoke.
const audio = {
  /** Decodes a file and leaves the device open and warming up. */
  load: (filePath) => ipcRenderer.invoke(CHANNEL.load, filePath),
  play: () => ipcRenderer.invoke(CHANNEL.play),
  restart: () => ipcRenderer.invoke(CHANNEL.restart),
  /** Releases the device. The track must be loaded again afterwards. */
  unload: () => ipcRenderer.invoke(CHANNEL.unload),
  /** True once starting playback will be heard immediately. */
  isReady: () => ipcRenderer.invoke(CHANNEL.isReady),
  setOffsetMs: (offsetMs) => ipcRenderer.invoke(CHANNEL.setOffsetMs, offsetMs),
  position: () => ipcRenderer.invoke(CHANNEL.position),
  stats: () => ipcRenderer.invoke(CHANNEL.stats),
};

contextBridge.exposeInMainWorld('electronAPI', { audio });
