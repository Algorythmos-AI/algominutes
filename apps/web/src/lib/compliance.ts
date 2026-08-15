// A10 launch-blocker compliance rails (web client).
//
// Thin wrappers over the server's compliance endpoints. As with billing.ts, the
// client never asserts anything authoritative — it only records the user's
// timestamped Terms/Privacy acceptance (#3), the note-retention preference (#5),
// support / bad-summary reports (#4), and the account-deletion request (#3, the
// Google Play "web-accessible deletion" requirement).
//
// Two invariants matter here:
//   • Support requests carry DIAGNOSTIC context only — app version, browser UA,
//     and (optionally) a note id for reference. They NEVER carry transcript,
//     summary, or audio content. The server enforces this too (it reads no such
//     field), but the client must not even collect it.
//   • Failures are reported through reportCrash, never console.* — the web app's
//     only crash-visibility channel (see lib/crashReport.ts).
import { authedFetch } from './authedFetch';
import { reportCrash } from './crashReport';
import { Capacitor } from './native-shim/core';
import {
  TERMS_VERSION,
  PRIVACY_VERSION,
} from '@algominutes/contracts';

// UI-only app version. Kept in sync with apps/web/package.json; overridable at
// build time via VITE_APP_VERSION so a release can stamp the real tag. This is
// diagnostic metadata only, never a gate.
export const APP_VERSION: string =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.VITE_APP_VERSION?.trim() || '0.1.0';

export type SupportKind = 'contact' | 'bad_transcript' | 'bad_summary';

/** The contract's platform enum. Web is always 'web' here. */
function platform(): 'ios' | 'android' | 'web' {
  const p = Capacitor.getPlatform();
  return p === 'ios' || p === 'android' ? p : 'web';
}

/** A short, non-identifying device string: the browser UA, capped. */
function deviceString(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return ua.length > 300 ? ua.slice(0, 300) : ua;
}

/**
 * #3 — Record a timestamped, versioned Terms + Privacy acceptance for the
 * signed-in user. Called once per account (see App.tsx's uid+version guard) at
 * signup / first permanent sign-in, and again whenever a document version is
 * bumped. Idempotent from the client's view: the server records each acceptance
 * with its own timestamp.
 */
export async function acceptTerms(): Promise<void> {
  const resp = await authedFetch('/v1/account/accept-terms', {
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION,
    appVersion: APP_VERSION,
    platform: platform(),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    reportCrash('accept_terms_failed', new Error(`accept_terms_http_${resp.status}`), {
      detail: detail.slice(0, 200),
    });
    throw new Error('Could not record your acceptance. Please try again.');
  }
}

/**
 * #5 — Set the note-retention preference. `retentionDays` is one of
 * RETENTION_OPTIONS_DAYS, or null for "keep until I delete". The server is the
 * source of truth; this only posts the choice.
 */
export async function setRetention(retentionDays: number | null): Promise<void> {
  const resp = await authedFetch('/v1/account/retention', { retentionDays });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    reportCrash('set_retention_failed', new Error(`retention_http_${resp.status}`), {
      detail: detail.slice(0, 200),
    });
    throw new Error('Could not update your retention setting. Please try again.');
  }
}

/**
 * #4 — Submit a support request or a bad-summary/bad-transcript report. Attaches
 * diagnostic context (app version, browser UA, platform) and, for content
 * reports, the note id as a REFERENCE only. Never sends transcript/summary/audio
 * content — there is deliberately no field for it.
 *
 * Returns the created request id so the UI can show a reference number.
 */
export async function submitSupport(input: {
  kind: SupportKind;
  message?: string;
  noteId?: string;
}): Promise<{ id: string }> {
  const body: Record<string, unknown> = {
    kind: input.kind,
    appVersion: APP_VERSION,
    device: deviceString(),
    platform: platform(),
  };
  const message = input.message?.trim();
  if (message) body.message = message.slice(0, 4000);
  if (input.noteId) body.noteId = input.noteId;

  const resp = await authedFetch('/v1/support', body);
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    reportCrash('support_submit_failed', new Error(`support_http_${resp.status}`), {
      kind: input.kind,
      detail: detail.slice(0, 200),
    });
    throw new Error('Could not send your message. Please try again.');
  }
  const data = (await resp.json().catch(() => ({}))) as { id?: string };
  return { id: data.id ?? '' };
}

/**
 * #3 — Request permanent deletion of the signed-in account and all its data.
 * Backs the web-accessible /delete-account page (a Google Play requirement) and
 * mirrors the in-app Settings → Delete flow. The server tears down Postgres
 * rows, Firestore notes, and the Auth user; the caller is responsible for the
 * subsequent signOut.
 */
export async function requestAccountDeletion(): Promise<void> {
  const resp = await authedFetch('/v1/account/delete', {});
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    reportCrash('account_delete_failed', new Error(`account_delete_http_${resp.status}`), {
      detail: detail.slice(0, 200),
    });
    throw new Error('Could not delete your account. Please try again or contact support.');
  }
}
