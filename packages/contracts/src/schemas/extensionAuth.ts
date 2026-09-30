// Signing the browser extension in (docs/plans/RELEASE.md PR 34,
// docs/decisions/0002-chrome-extension.md §3). The signed-in web app asks for a
// one-time code bound to the extension and a verifier only the extension holds;
// the extension trades the code and the verifier for a Firebase custom token.
import { z } from './zod';
import { IsoDateTime } from './common';

// Chrome's and Edge's extension ids: 32 letters a-p.
const ExtensionId = z.string().regex(/^[a-p]{32}$/).openapi({ example: 'abcdefghijklmnopabcdefghijklmnop' });

export const ExtensionLinkRequest = z
  .object({
    extensionId: ExtensionId,
    // base64url(SHA-256(verifier)), no padding (PKCE's S256). The verifier stays in the extension.
    verifierHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/).openapi({ example: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM' }),
  })
  .openapi('ExtensionLinkRequest');

export const ExtensionLinkResponse = z
  .object({
    // One use, 60 seconds. The web app passes it to the extension and nowhere else.
    code: z.string().min(43).max(43),
    expiresAt: IsoDateTime,
  })
  .openapi('ExtensionLinkResponse');

export const ExtensionTokenRequest = z
  .object({
    code: z.string().min(1).max(128),
    // PKCE's verifier: 43-128 characters of A-Z a-z 0-9 - . _ ~
    verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
    extensionId: ExtensionId,
  })
  .openapi('ExtensionTokenRequest');

export const ExtensionTokenResponse = z
  .object({
    // For Firebase's signInWithCustomToken; it expires in an hour.
    customToken: z.string().min(1),
  })
  .openapi('ExtensionTokenResponse');

// `extension_link_invalid` covers an unknown, spent, expired or mismatched code, so
// a guess learns nothing. `feature_disabled`: no extension is allowed yet.
export const ExtensionAuthError = z
  .object({ error: z.enum(['extension_link_invalid', 'extension_unknown', 'feature_disabled']) })
  .openapi('ExtensionAuthError');

export type ExtensionLinkRequest = z.infer<typeof ExtensionLinkRequest>;
export type ExtensionLinkResponse = z.infer<typeof ExtensionLinkResponse>;
export type ExtensionTokenRequest = z.infer<typeof ExtensionTokenRequest>;
export type ExtensionTokenResponse = z.infer<typeof ExtensionTokenResponse>;
export type ExtensionAuthError = z.infer<typeof ExtensionAuthError>;
