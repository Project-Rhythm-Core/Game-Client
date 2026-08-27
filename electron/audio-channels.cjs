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
  /** Load a chart's music and its whole sample bank in one go. */
  loadChart: 'audio:load-chart',
  /** Fire one sound from the bank immediately. */
  playSample: 'audio:play-sample',
  droppedSamples: 'audio:dropped-samples',
});

/** @type {Readonly<Record<string, string>>} */
const CHART_CHANNEL = Object.freeze({
  /** Convert a source chart and return it, along with the folder its media lives in. */
  import: 'chart:import',
  /** List the source charts bundled with the build, for picking one to play. */
  listBundled: 'chart:list-bundled',
});

/** @type {Readonly<Record<string, string>>} */
const SKIN_CHANNEL = Object.freeze({
  /** The active skin's identity and its visual theme. */
  active: 'skin:active',
  /** Every skin that can be chosen. */
  list: 'skin:list',
  /** Switch to a skin by folder name, and return what was loaded. */
  use: 'skin:use',
});

module.exports = { AUDIO_CHANNEL, CHART_CHANNEL, SKIN_CHANNEL };
