// Signing the extension in as the web app's user (RELEASE.md PR 37a, ADR 0002 §3):
//   1. hello: the web app's "Connect the extension" page asks; the extension makes a verifier, keeps it, and
//      answers only its hash.
//   2. The page asks the api for a one-time code bound to that hash (POST /v1/auth/extension-link).
//   3. link: the page hands the code over; the extension trades it and the verifier for a custom token
//      (POST /v1/auth/extension-token), then signs in to Firebase with it.
// A verifier is good for one try, and for two minutes (the code itself lives 60 seconds).
import { config } from '../config';
import { apiFetch, signInWithCustomToken, AuthRefusedError } from './http';
import { newVerifier, s256 } from './pkce';
import { saveSession, type Deps as SessionDeps } from './session';

export interface Deps extends SessionDeps {
  /** chrome.runtime.id: the api checks the code was made for this extension. */
  extensionId: string;
}

const PENDING = 'pendingLink';
export const PENDING_TTL_MS = 2 * 60 * 1000;

export async function hello(deps: Deps): Promise<{ ok: true; verifierHash: string; version: string }> {
  const verifier = newVerifier();
  await deps.storage.set({ [PENDING]: { verifier, createdAt: deps.now() } });
  return { ok: true, verifierHash: await s256(verifier), version: config.version };
}

export type LinkResult =
  | { ok: true; uid: string }
  // expired: no hello, or too long ago; refused: the api or Firebase said no; please_update: this build is too old.
  | { ok: false; error: 'expired' | 'refused' | 'please_update' };

export async function link(deps: Deps, code: string): Promise<LinkResult> {
  const pending = (await deps.storage.get(PENDING))[PENDING] as { verifier: string; createdAt: number } | undefined;
  // One try per hello, as the api's code is one try.
  await deps.storage.remove(PENDING);
  if (!pending || deps.now() - pending.createdAt > PENDING_TTL_MS) return { ok: false, error: 'expired' };

  const res = await apiFetch(deps.fetch, '/v1/auth/extension-token', {
    method: 'POST',
    body: { code, verifier: pending.verifier, extensionId: deps.extensionId },
  });
  if (res.status === 426) return { ok: false, error: 'please_update' };
  if (!res.ok) return { ok: false, error: 'refused' };
  // The contract's ExtensionTokenResponse (packages/contracts), checked by hand: zod would be most of the bundle.
  const customToken = ((await res.json()) as { customToken?: unknown }).customToken;
  if (typeof customToken !== 'string' || !customToken) return { ok: false, error: 'refused' };
  try {
    const session = await saveSession(deps, await signInWithCustomToken(deps.fetch, customToken));
    return { ok: true, uid: session.uid };
  } catch (err) {
    // silent-catch-ok: Firebase refusing the custom token is the answer 'refused', which the web page shows; anything else is rethrown
    if (err instanceof AuthRefusedError) return { ok: false, error: 'refused' };
    throw err;
  }
}
