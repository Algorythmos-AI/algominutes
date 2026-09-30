// Builds the extension into dist/ for one environment (docs/decisions/0002-chrome-extension.md).
//
//   EXT_API_ORIGIN=https://<api> EXT_WEB_ORIGINS=https://<web>[,https://<web>] EXT_FIREBASE_API_KEY=<key> node build.mjs
//
// Manifest V3 runs no remote code, so everything environment-specific is fixed here: the api origin, the web
// origins that may message the extension, and the Firebase Web API key (a public identifier). A missing or
// malformed value fails the build rather than shipping an extension that calls nowhere.
import { build } from 'esbuild';
import { mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// The service worker, the popup, the offscreen recorder, and the page that asks for the microphone.
export const ENTRIES = ['background', 'popup', 'offscreen', 'permission'];
export const PAGES = ['popup.html', 'offscreen.html', 'permission.html'];
const out = resolve(here, 'dist');

/** An origin as the extension uses it: https (http only for localhost), no path. */
export function parseOrigin(raw, name) {
  const value = String(raw ?? '').trim();
  if (!value) throw new Error(`${name} is not set`);
  const url = new URL(value);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error(`${name} must be https: ${value}`);
  if (url.pathname !== '/' || url.search || url.hash) throw new Error(`${name} must be an origin, with no path: ${value}`);
  return url.origin;
}

export function settingsFrom(env) {
  const apiOrigin = parseOrigin(env.EXT_API_ORIGIN, 'EXT_API_ORIGIN');
  const webOrigins = String(env.EXT_WEB_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    .map((o) => parseOrigin(o, 'EXT_WEB_ORIGINS'));
  if (!webOrigins.length) throw new Error('EXT_WEB_ORIGINS is not set');
  // Any page on a web origin can hand the extension a sign-in code, so a build for testers trusts only the web
  // app's own https origins: a localhost one only in a development build (EXT_DEV=1).
  const local = webOrigins.filter((o) => new URL(o).protocol === 'http:');
  if (local.length && env.EXT_DEV !== '1') throw new Error(`EXT_WEB_ORIGINS has ${local.join(', ')}: only a development build (EXT_DEV=1) may trust localhost`);
  const firebaseApiKey = String(env.EXT_FIREBASE_API_KEY ?? '').trim();
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(firebaseApiKey)) throw new Error('EXT_FIREBASE_API_KEY is not set, or not a key');
  return { apiOrigin, webOrigins, firebaseApiKey };
}

/**
 * The manifest. Every permission is one ADR 0002 §5 lists and explains:
 *   - storage: the session and the recording's state, in chrome.storage.session;
 *   - tabCapture: the meeting tab's sound (the other people);
 *   - offscreen: a document that holds the streams and records for the whole meeting;
 *   - the api's origin, and Cloud Storage's, where the recording is uploaded while it's made;
 *   - meet.google.com: knowing the popup's tab is a Meet, and its link, to send the notetaker (37c). There is
 *     no content script: nothing is drawn into Meet's page.
 */
export function manifestFor(settings, version) {
  return {
    manifest_version: 3,
    name: 'AlgoMinutes',
    version,
    description: 'Record your meetings into AlgoMinutes: summaries, action items and a searchable transcript.',
    minimum_chrome_version: '116',
    background: { service_worker: 'background.js', type: 'module' },
    action: { default_title: 'AlgoMinutes', default_popup: 'popup.html' },
    permissions: ['storage', 'tabCapture', 'offscreen'],
    host_permissions: [`${settings.apiOrigin}/*`, 'https://storage.googleapis.com/*', 'https://meet.google.com/*'],
    externally_connectable: { matches: settings.webOrigins.map((o) => `${o}/*`) },
  };
}

async function main() {
  const settings = settingsFrom(process.env);
  const { version } = JSON.parse(await readFile(resolve(here, 'package.json'), 'utf8'));
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await build({
    entryPoints: Object.fromEntries(ENTRIES.map((e) => [e, resolve(here, `src/${e}.ts`)])),
    outdir: out,
    bundle: true,
    format: 'esm',
    target: 'chrome116',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    define: {
      __EXT_API_ORIGIN__: JSON.stringify(settings.apiOrigin),
      __EXT_WEB_ORIGINS__: JSON.stringify(settings.webOrigins),
      __EXT_FIREBASE_API_KEY__: JSON.stringify(settings.firebaseApiKey),
      __EXT_VERSION__: JSON.stringify(version),
    },
  });
  for (const page of PAGES) await copyFile(resolve(here, `src/${page}`), resolve(out, page));
  await writeFile(resolve(out, 'manifest.json'), `${JSON.stringify(manifestFor(settings, version), null, 2)}\n`);
  process.stdout.write(`built dist/ for ${settings.apiOrigin} (${settings.webOrigins.join(', ')}), version ${version}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`extension build failed: ${err.message}\n`);
    process.exit(1);
  });
}
