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

/** Canonical sound name to absolute path, for the active skin. Empty until one loads. */
let sounds = {};
let active = null;

/**
 * Every skin activated this session, by id.
 *
 * Switching skins does not evict the old one, and that is the point. The renderer loads
 * textures through `skin://<id>/…`, and its asset loader caches by URL — so an id has to
 * keep meaning the same files for as long as any texture fetched under it might still be
 * around. Serving only the current skin would hand the new one's bytes out under the old
 * one's URLs the moment anything asked again.
 */
const loaded = new Map();

/**
 * The `skin://` host a skin is served under.
 *
 * Usually just its id. The exception matters: the scheme is registered as `standard`, so
 * Chromium parses its host by the special-scheme rules and applies IDNA to it. An id that
 * is not plain ASCII — a skin folder named entirely in Japanese slugs to one, and those
 * are not rare — would reach here punycoded and match nothing. Encoding those keeps the
 * host inside the character set the URL parser leaves alone.
 *
 * Decided here and handed to the renderer rather than derived at both ends, for the same
 * reason the id itself is: two spellings of it means textures that quietly 404.
 */
function hostFor(id) {
  return /^[a-z0-9-]+$/.test(id) ? id : `x${Buffer.from(id, 'utf8').toString('hex')}`;
}

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
    const url = new URL(request.url);

    // The host is the skin's id. `active` is still accepted as an alias for whichever is
    // current, which is what a caller wants before it knows the id.
    const skin = url.hostname === 'active' ? active : loaded.get(url.hostname);
    if (!skin) return new Response('unknown skin', { status: 404 });

    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const root = path.resolve(skin.dir);
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
  // The id is asked for rather than derived here. It is the host of the `skin://` URL the
  // renderer fetches through, so a second spelling of it means textures that 404.
  const id = core.skinId(folderName);

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

  // Re-imported on every selection rather than cached by folder. This is the screen for
  // finding out what a skin gets wrong, so editing one and picking it again has to show
  // the edit; a cache would quietly serve the previous attempt.
  const output = path.join(SKIN_CACHE, folderName);
  const summary = core.importSkin(source, output);

  return activate(output, { ...summary, imported: true });
}

/**
 * Every skin that can be chosen: packages already in the game's format, and source skins
 * to import on demand.
 *
 * Listed by folder rather than by the name inside the skin, because this is a testing
 * screen: the folder is what you go and edit when something draws wrong. A skin the core
 * does not recognise is still listed, with `readable: false`, so it can be selected and
 * the failure seen rather than the skin silently missing from the list.
 */
function listSkins() {
  const found = new Map();

  const scan = (root, converted) => {
    if (!fs.existsSync(root)) return;

    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const dir = path.join(root, entry.name);
      const readable = converted
        ? fs.existsSync(path.join(dir, 'skin.yaml'))
        : core.skinFormats().length > 0 && recognised(dir);

      found.set(core.skinId(entry.name), {
        id: core.skinId(entry.name),
        folder: entry.name,
        converted,
        readable,
      });
    }
  };

  // Converted packages are scanned last so they win: they are what `loadSkin` prefers.
  scan(BUNDLED_SKINS, false);
  scan(CONVERTED_SKINS, true);

  return [...found.values()].sort((a, b) => a.folder.localeCompare(b.folder));
}

/**
 * Whether any importer claims this folder.
 *
 * Asked of the core rather than guessed at here — recognising a skin is the importer's
 * job, and it is the only thing that knows what its own format looks like.
 */
function recognised(dir) {
  try {
    return core.skinImporterFor(dir) !== null;
  } catch {
    return false;
  }
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
    host: hostFor(info.id),
    soundCount: Object.keys(sounds).length,
    theme: theme ? JSON.parse(theme) : null,
  };

  loaded.set(active.host, active);

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
  listSkins,
  activeSkin,
  theme,
  resolveSample,
  registerSkinScheme,
  serveSkinFiles,
  SKIN_SCHEME,
  DEFAULT_SKIN_FOLDER,
};
