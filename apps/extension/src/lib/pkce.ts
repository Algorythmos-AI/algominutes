// The extension's half of the sign-in handshake (ADR 0002 §3): a verifier only it holds, and the SHA-256 the
// web app may see (PKCE's S256, RFC 7636). The api binds a one-time code to that hash, so a code seen by
// anyone else is useless without the verifier.

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** 32 random bytes, base64url: 43 characters of A-Z a-z 0-9 - _ (RFC 7636 §4.1 allows 43-128). */
export function newVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** base64url(SHA-256(verifier)), no padding: what POST /v1/auth/extension-link binds the code to. */
export async function s256(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}
