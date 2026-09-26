/**
 * Human-readable sign-in failures.
 *
 * The login buttons used to alert `err.message` directly, so a
 * misconfiguration surfaced to the user as:
 *
 *     Apple sign-in failed: Firebase: Error (auth/operation-not-allowed).
 *
 * That tells a clinician nothing they can act on, and it leaks the internals
 * of our auth setup to anyone who taps a button. The code still goes to
 * `console.error` for us; the person gets a sentence.
 *
 * The mapped codes are the ones that actually occur for this app's providers —
 * they are the same failure table recorded in
 * `docs/runbooks/apple-signin-web.md`.
 */

/** Firebase puts the code on `err.code`; everything else is best-effort. */
function codeOf(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === 'string') return c;
  }
  return '';
}

/**
 * A sentence to show the user, or `null` when nothing should be shown.
 *
 * `null` for the cancellation cases: someone who closed the popup knows they
 * closed it, and an alert telling them so is noise.
 */
export function signInErrorMessage(err: unknown, provider: 'apple' | 'google' | 'guest'): string | null {
  const label = provider === 'apple' ? 'Apple' : provider === 'google' ? 'Google' : 'Guest';

  switch (codeOf(err)) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
    case 'auth/user-cancelled':
      return null;

    case 'auth/popup-blocked':
      return 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.';

    // The whole reason this module exists. Provider enabled in the console but
    // not configured for web — indistinguishable from "disabled" at runtime.
    case 'auth/operation-not-allowed':
      return `${label} sign-in isn't available yet. Please use the other sign-in option for now.`;

    case 'auth/invalid-credential':
    case 'auth/invalid-oauth-client-id':
      return `${label} sign-in is misconfigured and couldn't complete. Please try the other option.`;

    case 'auth/unauthorized-domain':
      return "This site isn't authorised for sign-in. If you typed the address, check it and try again.";

    case 'auth/account-exists-with-different-credential':
      return 'You already have an account using a different sign-in method. Use the one you signed up with.';

    case 'auth/network-request-failed':
      return 'Sign-in failed because of a network problem. Check your connection and try again.';

    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a moment and try again.';

    case 'auth/user-disabled':
      return 'This account has been disabled. Contact support if you think that is wrong.';

    // argument-error means our own initialisation is wrong (a missing
    // popupRedirectResolver, historically). Nothing the user can do.
    case 'auth/argument-error':
    default:
      return `${label} sign-in didn't complete. Please try again.`;
  }
}
