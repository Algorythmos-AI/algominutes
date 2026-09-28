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
// env can't make a client show a button that leads nowhere.

export const NOTETAKER_SURFACES = ['bot', 'calendar', 'zoomImport', 'extension'];
// Surfaces with a server implementation. Each M-milestone PR adds its own.
export const NOTETAKER_BUILT = new Set([]);

export function notetakerSwitches(env = process.env, built = NOTETAKER_BUILT) {
  const named = new Set(
    String(env.NOTETAKER || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return Object.fromEntries(NOTETAKER_SURFACES.map((s) => [s, named.has(s) && built.has(s)]));
}

export function appConfig(env = process.env) {
  return {
    broadcastCapture: String(env.BROADCAST_CAPTURE || 'on').trim().toLowerCase() !== 'off',
    notetaker: notetakerSwitches(env),
  };
}

export async function appConfigRoute(_req, res) {
  return res.json(appConfig());
}
