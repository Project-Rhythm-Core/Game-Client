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

/**
 * What the page is allowed to load, and from where.
 *
 * Electron warns loudly when a renderer has no policy, and the warning is fair: without
 * one there is nothing between a bug in a chart or skin name and arbitrary loading. The
 * shape follows what the game actually does — its own bundle, and skin artwork through the
 * `skin:` scheme — so anything else is a mistake by definition.
 *
 * `style-src` has to allow inline styles: Svelte emits component CSS as a `<style>` block,
 * and the playfield sets sizes inline. Scripts get no such exemption, which is the half
 * that matters — note the absence of `unsafe-eval`, whose presence is the other thing
 * Electron's warning is about.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' skin: data: blob:",
  "media-src 'self' skin: data: blob:",
  "font-src 'self' skin: data:",
  "connect-src 'self' skin: data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Root of the built renderer. */
const DIST = path.join(__dirname, '..', 'dist');

/**
 * What this scheme needs, for the one registration call the app is allowed.
 *
 * A descriptor rather than a `register()` of its own: `registerSchemesAsPrivileged` may be
 * called **once**, and a second call replaces the first rather than adding to it. Two
 * modules each registering their own scheme therefore leaves one of them unprivileged —
 * which is silent, and costs `secure: true`, and with it every API that requires a secure
 * context. See `registerSchemes` in `main.cjs`.
 */
const SCHEME = {
  scheme: APP_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    allowServiceWorkers: true,
    corsEnabled: true,
  },
};

/** Starts serving the build. Must run after the app is ready. */
function serveApp() {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';

    const root = path.resolve(DIST);
    const file = path.resolve(root, relative);

    // The renderer should not be able to read the disk through a path it made up.
    if (file !== root && !file.startsWith(root + path.sep)) {
      return new Response('outside the app', { status: 403 });
    }

    const response = await net.fetch(pathToFileURL(file).toString());

    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);

    return new Response(response.body, { status: response.status, headers });
  });
}

/** Where the window should point. */
const APP_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

module.exports = { SCHEME, serveApp, APP_URL, APP_SCHEME };
