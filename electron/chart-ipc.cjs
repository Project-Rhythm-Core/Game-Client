// Chart importing, in the main process.
//
// Conversion happens here rather than in the renderer because it reads the filesystem:
// a chart's sample references are resolved against its own folder. The renderer only
// ever sees the game's own format.

const { ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { CHART_CHANNEL, SKIN_CHANNEL } = require('./audio-channels.cjs');
const skin = require('./skin.cjs');
const core = require('../rust-core/rust-core.node');

/** Source charts that ship with the build, used while there is no song library yet. */
const BUNDLED_ROOT = path.join(__dirname, '..', 'rust-core', 'assets');

/** Converted charts land here; they are derived data, not worth keeping. */
const CACHE_DIR = path.join(os.tmpdir(), 'project-rhythm-core', 'charts');

/**
 * Extensions the native core can import, as a lookup.
 *
 * Asked for rather than restated here. Keeping a second copy is how `.osu` ended up
 * spelled out in the shell, where it silently decided which formats the game could see.
 */
const CHART_EXTENSIONS = new Set(core.chartExtensions().map((e) => `.${e.toLowerCase()}`));

/** Every importable chart under the bundled assets, one level deep. */
function listBundled() {
  if (!fs.existsSync(BUNDLED_ROOT)) return [];

  const found = [];
  const visit = (dir, depth) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth > 0) {
        visit(full, depth - 1);
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      if (entry.isFile() && CHART_EXTENSIONS.has(extension)) {
        found.push({ path: full, name: path.basename(entry.name, extension) });
      }
    }
  };

  visit(BUNDLED_ROOT, 1);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Converts a source chart of any supported format and reads the result back.
 *
 * The chart travels as parsed JSON while its audio stays on disk, because the audio is
 * loaded by the native engine from a path rather than handed across the boundary.
 */
async function importChart(sourcePath) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const stem = path.basename(sourcePath, path.extname(sourcePath));
  const outputPath = path.join(CACHE_DIR, `${stem}.json`);
  const summary = await core.convertChart(sourcePath, outputPath);
  const chart = JSON.parse(fs.readFileSync(outputPath, 'utf8'));

  const mediaDir = path.dirname(sourcePath);

  return {
    chart,
    summary,
    /** Where the chart's audio and samples live. */
    mediaDir,
    /** Absolute path to the background track, when the chart has one. */
    audioPath: chart.audio ? path.join(mediaDir, chart.audio.file) : null,
    /**
     * Absolute paths for the sample bank, in chart index order.
     *
     * Resolved here because the renderer has no business knowing where media lives, and
     * kept positional because notes refer to samples by index. A sound the chart does
     * not ship falls back to the active skin.
     */
    samplePaths: chart.samples.map((sample) => skin.resolveSample(mediaDir, sample.file)),
  };
}

function registerChartHandlers() {
  // Import the default skin up front so the first chart already has its fallback sounds.
  const loaded = skin.loadSkin();
  if (loaded) {
    console.log(`[skin] ${loaded.name} by ${loaded.author || 'unknown'} — ${loaded.soundCount} sounds`);
  }

  ipcMain.handle(CHART_CHANNEL.listBundled, () => listBundled());
  ipcMain.handle(CHART_CHANNEL.import, (_event, sourcePath) => importChart(sourcePath));
  ipcMain.handle(SKIN_CHANNEL.active, () => {
    const s = skin.activeSkin();
    return s ? { id: s.id, name: s.name, author: s.author, theme: skin.theme() } : null;
  });
}

module.exports = { registerChartHandlers };
