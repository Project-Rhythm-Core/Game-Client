// Serves the built renderer from a scheme of its own.
//
// Loading the app with `loadFile` puts the page on `file://`, which Chromium treats as a
// degraded origin: a cross-origin `fetch` from there is refused outright, whatever
// headers the other side sends. That breaks any asset loader that uses `fetch` — Pixi's
// texture loader included — and no amount of CORS configuration fixes it, because the
// restriction is about the origin rather than the response.
//
// Giving the app a real origin removes the whole class of problem, and costs one handler.

const { protocol, net } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

const APP_SCHEME = 'app';
const APP_HOST = 'local';

/** Root of the built renderer. */
const DIST = path.join(__dirname, '..', 'dist');

/** Declares the scheme. Must run before the app is ready. */
function registerAppScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        allowServiceWorkers: true,
        corsEnabled: true,
      },
    },
  ]);
}

/** Starts serving the build. Must run after the app is ready. */
function serveApp() {
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';

    const root = path.resolve(DIST);
    const file = path.resolve(root, relative);

    // The renderer should not be able to read the disk through a path it made up.
    if (file !== root && !file.startsWith(root + path.sep)) {
      return new Response('outside the app', { status: 403 });
    }

    return net.fetch(pathToFileURL(file).toString());
  });
}

/** Where the window should point. */
const APP_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

module.exports = { registerAppScheme, serveApp, APP_URL, APP_SCHEME };
