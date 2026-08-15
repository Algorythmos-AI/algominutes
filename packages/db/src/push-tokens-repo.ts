/**
 * push_tokens repo (A7.3). The api register-push-token endpoint upserts here;
 * services/notifier reads tokens to fan out FCM. Device tokens only — no PII.
 */
import { getPool, isPostgresEnabled } from './db.js';

export interface PushTokenInput {
  token: string;
  uid: string;
  platform: 'ios' | 'android' | 'web';
  appVersion?: string | null;
}

/** Upsert a device token, re-homing it to the current user if it moved devices/accounts. */
export async function registerPushToken(input: PushTokenInput): Promise<void> {
  if (!isPostgresEnabled()) return;
  await getPool().query(
    `INSERT INTO push_tokens (token, uid, platform, app_version, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (token) DO UPDATE
       SET uid = EXCLUDED.uid, platform = EXCLUDED.platform,
           app_version = EXCLUDED.app_version, updated_at = NOW()`,
    [input.token, input.uid, input.platform, input.appVersion ?? null],
  );
}

/** All device tokens for a user (across their devices). */
export async function tokensForUser(uid: string): Promise<{ token: string; platform: string }[]> {
  if (!isPostgresEnabled()) return [];
  const { rows } = await getPool().query(
    `SELECT token, platform FROM push_tokens WHERE uid = $1`,
    [uid],
  );
  return rows as { token: string; platform: string }[];
}

/** Remove a token (e.g. FCM reported it unregistered). */
export async function deletePushToken(token: string): Promise<void> {
  if (!isPostgresEnabled()) return;
  await getPool().query(`DELETE FROM push_tokens WHERE token = $1`, [token]);
}
