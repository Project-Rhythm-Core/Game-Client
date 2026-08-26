// Channel names shared by the main process and the preload bridge.
//
// Kept dependency-free on purpose: the preload script runs in the renderer, where
// ipcMain and the native addon are not available, so it must be able to require the
// channel list without pulling either in.

/** @type {Readonly<Record<string, string>>} */
const CHANNEL = Object.freeze({
  load: 'audio:load',
  play: 'audio:play',
  restart: 'audio:restart',
  unload: 'audio:unload',
  isReady: 'audio:is-ready',
  setOffsetMs: 'audio:set-offset-ms',
  position: 'audio:position',
  stats: 'audio:stats',
});

module.exports = { CHANNEL };
