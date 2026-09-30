// The extension's network calls: the AlgoMinutes api, and Firebase Auth's REST endpoints (the extension
// signs in without the Firebase SDK, which a service worker doesn't need).
import { config, CLIENT_HEADER_VALUE } from '../config';

export type Fetch = typeof fetch;

/** A call to the api, with the client header every client sends and a trace id to follow it in the logs. */
export function apiFetch(f: Fetch, path: string, init: { method: 'GET' | 'POST'; body?: unknown; idToken?: string }): Promise<Response> {
  const headers: Record<string, string> = {
    'X-AlgoMinutes-Client': CLIENT_HEADER_VALUE,
    'X-Trace-Id': crypto.randomUUID(),
  };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.idToken) headers.Authorization = `Bearer ${init.idToken}`;
  return f(`${config.apiOrigin}${path}`, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

export interface FirebaseTokens {
  idToken: string;
  refreshToken: string;
  /** Seconds the ID token lasts (an hour). */
  expiresIn: number;
}

/** Firebase Auth: sign in with the custom token the api minted (accounts:signInWithCustomToken). */
export async function signInWithCustomToken(f: Fetch, token: string): Promise<FirebaseTokens> {
  const res = await f(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(config.firebaseApiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, returnSecureToken: true }),
  });
  if (!res.ok) throw new AuthRefusedError(res.status);
  const body = (await res.json()) as { idToken?: unknown; refreshToken?: unknown; expiresIn?: unknown };
  return tokens(body.idToken, body.refreshToken, body.expiresIn);
}

/** Firebase Auth: a fresh ID token for a refresh token (securetoken's token endpoint). */
export async function refreshIdToken(f: Fetch, refreshToken: string): Promise<FirebaseTokens> {
  const res = await f(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(config.firebaseApiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
  });
  if (!res.ok) throw new AuthRefusedError(res.status);
  const body = (await res.json()) as { id_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  return tokens(body.id_token, body.refresh_token, body.expires_in);
}

/** Firebase said no (a revoked, expired or unknown session), as opposed to the network failing. */
export class AuthRefusedError extends Error {
  constructor(readonly status: number) {
    super(`firebase auth refused (${status})`);
  }
}

function tokens(idToken: unknown, refreshToken: unknown, expiresIn: unknown): FirebaseTokens {
  const seconds = Number(expiresIn);
  if (typeof idToken !== 'string' || typeof refreshToken !== 'string' || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('firebase auth answered without tokens');
  }
  return { idToken, refreshToken, expiresIn: seconds };
}

/** The user an ID token is for (its `sub`). Only read, never trusted: the api verifies the token. */
export function uidOf(idToken: string): string {
  const payload = idToken.split('.')[1] ?? '';
  const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
  const sub = (JSON.parse(json) as { sub?: unknown }).sub;
  if (typeof sub !== 'string' || !sub) throw new Error('ID token without a subject');
  return sub;
}
