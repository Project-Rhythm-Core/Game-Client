const { contextBridge, ipcRenderer } = require('electron');

const { AUDIO_CHANNEL, CHART_CHANNEL } = require('./electron/audio-channels.cjs');

// Mirrors the audio IPC surface into the renderer. Everything returns a promise,
// including the void operations, because it all crosses ipcRenderer.invoke.
const audio = {
  /** Decodes a file and leaves the device open and warming up. */
  load: (filePath) => ipcRenderer.invoke(AUDIO_CHANNEL.load, filePath),
  play: () => ipcRenderer.invoke(AUDIO_CHANNEL.play),
  restart: () => ipcRenderer.invoke(AUDIO_CHANNEL.restart),
  /** Releases the device. The track must be loaded again afterwards. */
  unload: () => ipcRenderer.invoke(AUDIO_CHANNEL.unload),
  /** True once starting playback will be heard immediately. */
  isReady: () => ipcRenderer.invoke(AUDIO_CHANNEL.isReady),
  setOffsetMs: (offsetMs) => ipcRenderer.invoke(AUDIO_CHANNEL.setOffsetMs, offsetMs),
  position: () => ipcRenderer.invoke(AUDIO_CHANNEL.position),
  stats: () => ipcRenderer.invoke(AUDIO_CHANNEL.stats),
  /** Decode a chart's music and sample bank together, and open the device. */
  loadChart: (request) => ipcRenderer.invoke(AUDIO_CHANNEL.loadChart, request),
  /**
   * Fire a sound now. Deliberately not a promise: a keypress must not wait for a round
   * trip before the sound is on its way.
   */
  playSample: (sampleIndex, volume) =>
    ipcRenderer.send(AUDIO_CHANNEL.playSample, sampleIndex, volume),
  droppedSamples: () => ipcRenderer.invoke(AUDIO_CHANNEL.droppedSamples),
};

// Charts are converted in the main process and arrive already in the game's format.
const chart = {
  /** Convert a `.osu` file and return the chart plus where its media lives. */
  importOsu: (sourcePath) => ipcRenderer.invoke(CHART_CHANNEL.importOsu, sourcePath),
  /** Source charts bundled with the build, for picking one to play. */
  listBundled: () => ipcRenderer.invoke(CHART_CHANNEL.listBundled),
};

contextBridge.exposeInMainWorld('electronAPI', { audio, chart });
