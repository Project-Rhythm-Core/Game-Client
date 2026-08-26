// Chart importing, in the main process.
//
// Conversion happens here rather than in the renderer because it reads the filesystem:
// a chart's sample references are resolved against its own folder. The renderer only
// ever sees the game's own format.

const { ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { CHART_CHANNEL } = require('./audio-channels.cjs');
const core = require('../rust-core/rust-core.node');

/** Source charts that ship with the build, used while there is no song library yet. */
const BUNDLED_ROOT = path.join(__dirname, '..', 'rust-core', 'assets');

/** Converted charts land here; they are derived data, not worth keeping. */
const CACHE_DIR = path.join(os.tmpdir(), 'project-rhythm-core', 'charts');

/** Every `.osu` under the bundled assets, one level deep. */
function listBundled() {
  if (!fs.existsSync(BUNDLED_ROOT)) return [];

  const found = [];
  const visit = (dir, depth) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth > 0) visit(full, depth - 1);
      else if (entry.isFile() && entry.name.endsWith('.osu')) {
        found.push({ path: full, name: entry.name.replace(/\.osu$/, '') });
      }
    }
  };

  visit(BUNDLED_ROOT, 1);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Converts a source chart and reads the result back.
 *
 * The chart travels as parsed JSON while its audio stays on disk, because the audio is
 * loaded by the native engine from a path rather than handed across the boundary.
 */
async function importOsu(sourcePath) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const outputPath = path.join(CACHE_DIR, `${path.basename(sourcePath, '.osu')}.json`);
  const summary = await core.convertOsuChart(sourcePath, outputPath);
  const chart = JSON.parse(fs.readFileSync(outputPath, 'utf8'));

  return {
    chart,
    summary,
    /** Where the chart's audio and samples live. */
    mediaDir: path.dirname(sourcePath),
    /** Absolute path to the background track, when the chart has one. */
    audioPath: chart.audio ? path.join(path.dirname(sourcePath), chart.audio.file) : null,
  };
}

function registerChartHandlers() {
  ipcMain.handle(CHART_CHANNEL.listBundled, () => listBundled());
  ipcMain.handle(CHART_CHANNEL.importOsu, (_event, sourcePath) => importOsu(sourcePath));
}

module.exports = { registerChartHandlers };
