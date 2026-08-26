// Bridges the native audio engine to the renderer, in the main process.
//
// Every handler is a thin pass-through: the engine owns all playback state, so there is
// nothing to cache or mirror here. Keeping this separate from window and lifecycle
// concerns means a new engine call only ever touches two places — this file and the
// preload bridge that mirrors it.

const { ipcMain } = require('electron');

const { CHANNEL } = require('./audio-channels.cjs');
const engine = require('../rust-core/rust-core.node');

/** Registers every audio handler. Call once, before the first window is created. */
function registerAudioHandlers() {
  ipcMain.handle(CHANNEL.load, (_event, filePath) => engine.loadAudio(filePath));
  ipcMain.handle(CHANNEL.play, () => engine.play());
  ipcMain.handle(CHANNEL.restart, () => engine.restart());
  ipcMain.handle(CHANNEL.unload, () => engine.unload());
  ipcMain.handle(CHANNEL.isReady, () => engine.isReady());
  ipcMain.handle(CHANNEL.setOffsetMs, (_event, offsetMs) => engine.setOffsetMs(offsetMs));
  ipcMain.handle(CHANNEL.position, () => engine.getPositionMs());
  ipcMain.handle(CHANNEL.stats, () => engine.getStats());
}

/**
 * Releases the output device.
 *
 * Worth doing explicitly on quit: otherwise the device can stay held after the process
 * is gone.
 */
function releaseAudio() {
  engine.unload();
}

module.exports = { registerAudioHandlers, releaseAudio };
