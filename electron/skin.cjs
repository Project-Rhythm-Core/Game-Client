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

const { protocol, net } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const core = require('../rust-core/rust-core.node');

/**
 * Scheme the renderer loads skin files through.
 *
 * The page is served from `file://`, and Chromium will not let one `file://` document
 * fetch another. A scheme of our own is the way out that does not involve turning off web
 * security: the main process decides what it will serve, and it will only serve from
 * inside the active skin.
 */
const SKIN_SCHEME = 'skin';

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
 *
 * Must name a folder that is actually under `BUNDLED_SKINS`: a name that matches nothing
 * leaves the game with no skin at all, and the only sign of it is that the playfield
 * quietly draws flat colour.
 */
const DEFAULT_SKIN_FOLDER = '『 - Nabos Skin Mix - 』';

/** Canonical sound name to absolute path. Empty until a skin is loaded. */
let sounds = {};
let active = null;

/**
 * Declares the scheme's privileges. Must run before the app is ready.
 *
 * `standard` gives it real URL semantics so relative paths resolve; `secure` keeps it out
 * of the mixed-content rules; `supportFetchAPI` is what lets the renderer's asset loader
 * use it at all.
 */
function registerSkinScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SKIN_SCHEME,
      // `corsEnabled` is what actually lets the renderer fetch from here. Without it
      // Chromium refuses the request before any header is considered, and the error
      // names CORS while the cause is the scheme's registration.
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

/**
 * Starts serving `skin://active/<path>`. Must run after the app is ready.
 *
 * Every request is resolved inside the active skin's folder and refused if it escapes —
 * a renderer should not be able to read the disk through a path it made up.
 */
function serveSkinFiles() {
  protocol.handle(SKIN_SCHEME, async (request) => {
    if (!active) return new Response('no skin loaded', { status: 404 });

    const url = new URL(request.url);

    // One host for now, and it means "whichever skin is active". Naming it rather than
    // ignoring it leaves room for `skin://<id>/…` once more than one can be loaded.
    if (url.hostname !== 'active') {
      return new Response('unknown skin', { status: 404 });
    }

    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const root = path.resolve(active.dir);
    const file = path.resolve(root, relative);

    if (file !== root && !file.startsWith(root + path.sep)) {
      return new Response('outside the skin', { status: 403 });
    }
    if (!fs.existsSync(file)) {
      return new Response('not found', { status: 404 });
    }

    const response = await net.fetch(pathToFileURL(file).toString());

    // The page is served from `file://`, so anything it loads from this scheme is a
    // cross-origin request. Without this header the fetch fails before the renderer ever
    // sees the bytes, and the failure gives no hint as to why.
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', '*');

    return new Response(response.body, { status: response.status, headers });
  });
}

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
  const summary = core.importSkin(source, output);

  return activate(output, { ...summary, imported: true });
}

function activate(dir, info) {
  sounds = core.loadSkinSounds(dir);

  // Which theme to read comes from the package rather than from a format named here. A
  // skin says what it themes; asking for `osu` regardless is how a second skin format
  // would have silently loaded nothing.
  const format = (info.themes ?? [])[0] ?? null;
  const theme = format ? core.readSkinTheme(dir, format) : null;

  active = {
    ...info,
    dir,
    format,
    soundCount: Object.keys(sounds).length,
    theme: theme ? JSON.parse(theme) : null,
  };

  return active;
}

/**
 * The active skin's visual theme, or `null` when it provides only sounds.
 *
 * Which source format it was authored for is the skin's business and is recorded on it;
 * the renderer draws whatever it is handed.
 */
function theme() {
  return active?.theme ?? null;
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

module.exports = {
  loadSkin,
  activeSkin,
  theme,
  resolveSample,
  registerSkinScheme,
  serveSkinFiles,
  SKIN_SCHEME,
  DEFAULT_SKIN_FOLDER,
};
