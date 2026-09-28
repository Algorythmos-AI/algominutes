// GET /v1/config — server-side switches the apps read at launch
// (AppConfigResponse), so a feature can be turned off without a build.
//
// broadcastCapture: the iOS "capture audio from another app" entry point, a
// broadcast upload extension and the top App Review risk. BROADCAST_CAPTURE=off
// hides it; anything else, or unset, leaves it on.
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

export async function appConfig(env = process.env, uid = null, opts = {}) {
  return {
    broadcastCapture: String(env.BROADCAST_CAPTURE || 'on').trim().toLowerCase() !== 'off',
    notetaker: await notetakerFor(uid, env, opts),
  };
}

export async function appConfigRoute(req, res) {
  return res.json(await appConfig(process.env, req.uid, { log: req.log }));
}
