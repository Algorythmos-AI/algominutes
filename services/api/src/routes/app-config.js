// GET /v1/config — server-side switches the apps read at launch
// (AppConfigResponse), so a feature can be turned off without a build.
//
// broadcastCapture: "Record a call": the iOS broadcast extension (development
// and staging builds only; the App Store build has none, DECISIONS.md
// 2026-10-29) and the web's call in another tab. OFF unless BROADCAST_CAPTURE=on:
// a missing env var never turns it on (production runs it off).
//
// notetaker: the online-meeting surfaces (docs/plans/MEETINGS.md), OFF unless
// named in NOTETAKER (comma-separated: bot, calendar, zoomImport, extension).
// A surface is only ever reported on once it's built (NOTETAKER_BUILT), so the
// env can't make a client show a button that leads nowhere. Until the legal
// opinion (docs/CONSENT.md §2.4) it's for allowlisted testers only: the caller
// must be in notetaker_testers (migration 024), which the owner grants with the
// db-job `grant-notetaker` handler, so no identity is ever in git. A failed
// lookup means off.
import { isNotetakerTester } from '@algominutes/db';
import { rootLogger } from '../middleware/trace.js';

export const NOTETAKER_SURFACES = ['bot', 'calendar', 'zoomImport', 'extension'];
// Surfaces with a server implementation. Each M-milestone PR adds its own.
export const NOTETAKER_BUILT = new Set(['bot']);

export function notetakerSwitches(env = process.env, built = NOTETAKER_BUILT) {
  const named = new Set(
    String(env.NOTETAKER || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return Object.fromEntries(NOTETAKER_SURFACES.map((s) => [s, named.has(s) && built.has(s)]));
}

const OFF = Object.freeze(Object.fromEntries(NOTETAKER_SURFACES.map((s) => [s, false])));

/**
 * The notetaker surfaces this caller may use: built, switched on, and they're
 * an allowlisted tester. The lookup only runs when something is switched on.
 */
export async function notetakerFor(uid, env = process.env, { built = NOTETAKER_BUILT, isTester = isNotetakerTester, log = rootLogger } = {}) {
  const on = notetakerSwitches(env, built);
  if (!uid || !Object.values(on).some(Boolean)) return { ...OFF };
  let allowed = false;
  try {
    allowed = await isTester(uid);
  } catch (err) {
    // Off, and loudly: a failed lookup never switches the notetaker on.
    log.error({ err }, 'notetaker_tester_lookup_failed');
  }
  return Object.fromEntries(Object.entries(on).map(([k, v]) => [k, v && allowed]));
}

/**
 * Share links (RELEASE.md PR 29): OFF unless SHARE_LINKS=on. A link is public (anyone with it can read the
 * note), and it opens in the web app, so it stays off until that viewer's host is public (the beta's).
 */
export function shareLinksOn(env = process.env) {
  return ['on', 'true', '1'].includes(String(env.SHARE_LINKS || '').trim().toLowerCase());
}

/** "Record a call" (see the top of this file): OFF unless BROADCAST_CAPTURE=on. */
export function broadcastCaptureOn(env = process.env) {
  return ['on', 'true', '1'].includes(String(env.BROADCAST_CAPTURE || '').trim().toLowerCase());
}

export async function appConfig(env = process.env, uid = null, opts = {}) {
  return {
    broadcastCapture: broadcastCaptureOn(env),
    notetaker: await notetakerFor(uid, env, opts),
    shareLinks: shareLinksOn(env),
  };
}

export async function appConfigRoute(req, res) {
  return res.json(await appConfig(process.env, req.uid, { log: req.log }));
}
