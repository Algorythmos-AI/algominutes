// GET /v1/config — server-side switches the apps read at launch
// (AppConfigResponse), so a feature can be turned off without a build.
//
// broadcastCapture: the iOS "capture audio from another app" entry point, a
// broadcast upload extension and the top App Review risk. BROADCAST_CAPTURE=off
// hides it; anything else, or unset, leaves it on.

export function appConfig(env = process.env) {
  return {
    broadcastCapture: String(env.BROADCAST_CAPTURE || 'on').trim().toLowerCase() !== 'off',
  };
}

export async function appConfigRoute(_req, res) {
  return res.json(appConfig());
}
