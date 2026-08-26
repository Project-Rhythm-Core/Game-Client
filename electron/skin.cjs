// The active skin, and the sound fallback it provides.
//
// A chart routinely names a sound it does not ship, expecting the player's skin to supply
// it — every difficulty of one bundled chart asks for `normal-hitnormal.wav` without
// providing it, and without a fallback those charts play with no hit sounds at all.
//
// Resolution is a three-step chain, tried in order:
//
//   the chart's own folder  ->  the active skin  ->  silence
//
// YAML is read through the native module rather than a JavaScript parser, so there is one
// implementation of the format and it is the same one that writes it.

const fs = require('fs');
const os = require('os');
const path = require('path');

const core = require('../rust-core/rust-core.node');

/** Source skins bundled with the build, until there is a skin library. */
const BUNDLED_SKINS = path.join(__dirname, '..', 'rust-core', 'assets', 'Skins');

/** Packages already in the game's own format, kept alongside the sources for testing. */
const CONVERTED_SKINS = path.join(__dirname, '..', 'rust-core', 'assets', 'skins');

/** Where a skin imported on demand lands; derived data, not worth keeping. */
const SKIN_CACHE = path.join(os.tmpdir(), 'project-rhythm-core', 'skins');

/**
 * Source folder of the skin used when none has been chosen.
 *
 * Stands in until the game ships one of its own — this is someone else's artwork, fine
 * to import locally and not fine to redistribute.
 */
const DEFAULT_SKIN_FOLDER = 'dpjam_percy';

/** Canonical sound name to absolute path. Empty until a skin is loaded. */
let sounds = {};
let active = null;

/**
 * Imports a source skin if it has not been imported yet, and loads its sound bank.
 *
 * Returns what was loaded, or `null` when the folder does not exist — a missing skin
 * leaves charts silent rather than refusing to start.
 */
function loadSkin(folderName = DEFAULT_SKIN_FOLDER) {
  const id = folderName.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

  // A package already in the game's format is used as-is. Importing is only for source
  // skins the player drops in, and it is what produced these in the first place.
  const converted = path.join(CONVERTED_SKINS, id);
  if (fs.existsSync(path.join(converted, 'skin.yaml'))) {
    return activate(converted, { ...core.readSkinManifest(converted), imported: false });
  }

  const source = path.join(BUNDLED_SKINS, folderName);
  if (!fs.existsSync(source)) {
    sounds = {};
    active = null;
    return null;
  }

  const output = path.join(SKIN_CACHE, folderName);
  const summary = core.importOsuSkin(source, output);

  return activate(output, { ...summary, imported: true });
}

function activate(dir, info) {
  sounds = core.loadSkinSounds(dir);
  active = { ...info, dir, soundCount: Object.keys(sounds).length };
  return active;
}

/** The skin currently loaded, if any. */
function activeSkin() {
  return active;
}

/**
 * Resolves one of a chart's sample references to a file that exists.
 *
 * `file` is the name the chart wrote. The chart's own folder wins; the skin only fills in
 * what is missing.
 */
function resolveSample(mediaDir, file) {
  const own = path.join(mediaDir, file);
  if (fs.existsSync(own)) return own;

  // The bank is keyed the way charts name sounds, so the extension comes off first.
  const canonical = file.replace(/\.[^.]*$/, '').toLowerCase();
  return sounds[canonical] ?? own;
}

module.exports = { loadSkin, activeSkin, resolveSample, DEFAULT_SKIN_FOLDER };
