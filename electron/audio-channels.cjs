// Channel names shared by the main process and the preload bridge.
//
// Kept dependency-free on purpose: the preload script runs in the renderer, where
// ipcMain and the native addon are not available, so it must be able to require the
// channel list without pulling either in.

/** @type {Readonly<Record<string, string>>} */
const AUDIO_CHANNEL = Object.freeze({
  load: 'audio:load',
  play: 'audio:play',
  restart: 'audio:restart',
  unload: 'audio:unload',
  isReady: 'audio:is-ready',
  setOffsetMs: 'audio:set-offset-ms',
  position: 'audio:position',
  stats: 'audio:stats',
});

/** @type {Readonly<Record<string, string>>} */
const CHART_CHANNEL = Object.freeze({
  /** Convert a source chart and return it, along with the folder its media lives in. */
  importOsu: 'chart:import-osu',
  /** List the source charts bundled with the build, for picking one to play. */
  listBundled: 'chart:list-bundled',
});

module.exports = { AUDIO_CHANNEL, CHART_CHANNEL };
