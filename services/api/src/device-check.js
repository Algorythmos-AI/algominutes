// A new iOS user's trial, checked with Apple (RELEASE.md PR 22). The app sends a fresh DeviceCheck token with
// its kickoff (X-Device-Attestation); Apple keeps two bits per device, across reinstalls, and bit0 records
// that the device has had its reverse trial. ensureTrial (packages/db) asks only when it's deciding a new
// user's trial, and marks the device once the trial starts.
//
// The key comes from Secret Manager at run time (devicecheck-key, a .p8 PEM the owner adds), with its key id
// and team id in the env. Not configured, no iOS device is taken as trial-eligible: a trial left open to every
// reinstall costs real minutes, so the service says so (devicecheck_not_configured) and opens new users on the
// free floor. The token identifies a device: it is never logged.
import deviceCheckModule from '@algominutes/ai/devicecheck.cjs';
import secretReaderModule from '@algominutes/ai/secret-reader.cjs';

const { createDeviceCheckClient } = deviceCheckModule;
const { createSecretReader } = secretReaderModule;

export const DEVICECHECK_SECRET = 'devicecheck-key';

export function createTrialDevices({
  env = process.env,
  readSecret = createSecretReader({ projectId: env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT }),
  createClient = createDeviceCheckClient,
} = {}) {
  let client = null;
  let clientPem = null;
  // The client, or what's missing: 'env' (no key id or team id) or 'secret' (no key in Secret Manager).
  async function deviceCheck(log) {
    if (!env.DEVICECHECK_KEY_ID || !env.APPLE_TEAM_ID) return { missing: 'env' };
    const pem = await readSecret(DEVICECHECK_SECRET, { log });
    if (!pem) return { missing: 'secret' };
    if (!client || clientPem !== pem) {
      client = createClient({
        keyId: env.DEVICECHECK_KEY_ID, teamId: env.APPLE_TEAM_ID, privateKeyPem: pem,
        environment: env.DEVICECHECK_ENV || 'production',
      });
      clientPem = pem;
    }
    return { client };
  }

  /** The kickoff's device, for ensureTrial; undefined when there's no iOS token to ask Apple about. */
  return function trialDeviceFor({ token, platform, log }) {
    if (platform !== 'ios' || !token) return undefined;
    let bits = null;
    return {
      async trialUsed() {
        const { client: dc, missing } = await deviceCheck(log);
        if (!dc) {
          log.error({ missing }, 'devicecheck_not_configured');
          return true;
        }
        try {
          bits = await dc.queryTwoBits(token);
        } catch (err) {
          // An outage (5xx, 429, the network) is thrown, so the kickoff is retried rather than the trial denied.
          // A refusal for good (our key, this device's token) would fail every retry the same way: no trial,
          // and it alerts.
          if (!err?.permanent) throw err;
          log.error({ err, status: err.status, reason: err.reason }, 'devicecheck_refused');
          return true;
        }
        const used = bits.found && bits.bit0;
        log.info({ trialUsed: used, known: bits.found }, 'trial_device_checked');
        return used;
      },
      async markTrialUsed() {
        const { client: dc, missing } = await deviceCheck(log);
        // ensureTrial logs the failure (trial_device_mark_failed): the device stays unmarked.
        if (!dc) throw new Error(`devicecheck_not_configured: ${missing}`);
        const current = bits ?? (await dc.queryTwoBits(token));
        // Both bits are written: bit1 keeps whatever it was.
        await dc.updateTwoBits(token, { bit0: true, bit1: current.found ? current.bit1 : false });
        log.info({}, 'trial_device_marked');
      },
    };
  };
}
