// Everything environment-specific is fixed when the extension is built (build.mjs): Manifest V3 runs no
// remote code, so there is nothing to fetch at run time. The Firebase Web API key is a public identifier,
// as it is in the web app.
declare const __EXT_API_ORIGIN__: string;
declare const __EXT_WEB_ORIGINS__: readonly string[];
declare const __EXT_FIREBASE_API_KEY__: string;
declare const __EXT_VERSION__: string;

export const config = {
  apiOrigin: __EXT_API_ORIGIN__,
  /** The web app's origins: the only pages that may talk to the extension (externally_connectable). */
  webOrigins: __EXT_WEB_ORIGINS__,
  firebaseApiKey: __EXT_FIREBASE_API_KEY__,
  version: __EXT_VERSION__,
} as const;

/** `X-AlgoMinutes-Client`: the api gates `extension` builds below MIN_SUPPORTED_CLIENT.extension (RELEASE.md PR 36). */
export const CLIENT_HEADER_VALUE = `extension/${config.version}`;
