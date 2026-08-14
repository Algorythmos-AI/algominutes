// API versioning — the SINGLE source of truth the api service imports.
//
// Policy (BUILD-PLAN A3): version from day one under `/v1`; never break a live
// version. Every client sends a version header; the server refuses an
// unsupported client with a friendly "please update", never a 500. iOS and web
// ship before Android, and old builds must keep working — so the minimum
// supported version is a floor that is only ever raised deliberately.

/** The current (and only) live API version. Paths are mounted under `/v1`. */
export const API_VERSION = 'v1' as const;

/** The URL prefix every route lives behind. */
export const API_BASE_PATH = `/${API_VERSION}` as const;

/**
 * The header every client must send so the server can gate stale builds.
 * Value format: `"<platform>/<semver>"`, e.g. `ios/1.4.0`, `web/2026.8.15`,
 * `android/1.0.0`.
 */
export const CLIENT_VERSION_HEADER = 'X-AlgoMinutes-Client';

/** The client platforms that send the version header. */
export const CLIENT_PLATFORMS = ['ios', 'android', 'web'] as const;
export type ClientPlatform = (typeof CLIENT_PLATFORMS)[number];

/**
 * The minimum client version the server will accept, per platform. A request
 * from an older build is refused with a friendly upgrade prompt (see
 * `isSupportedClient`), not an error.
 *
 * All three start at `1.0.0` — the first-shipped floor. Raise a value ONLY when
 * a live version genuinely cannot be supported; lowering it or breaking a live
 * version is forbidden by the A3 contract. Android ships after iOS and web, so
 * its floor moves independently.
 */
export const MIN_SUPPORTED_CLIENT: Record<ClientPlatform, string> = {
  ios: '1.0.0',
  android: '1.0.0',
  web: '1.0.0',
};

/** The message the server returns when it refuses a stale client. */
export const UNSUPPORTED_CLIENT_MESSAGE =
  'Please update AlgoMinutes to the latest version to continue.';

/** A parsed `X-AlgoMinutes-Client` value. */
export interface ParsedClientVersion {
  platform: ClientPlatform;
  version: string;
}

/**
 * Parse a `X-AlgoMinutes-Client` header value, or null if it is missing or
 * malformed. Pure — no throw — so a bad header is a policy decision (refuse),
 * not a crash.
 */
export function parseClientVersion(header: string | null | undefined): ParsedClientVersion | null {
  if (!header || typeof header !== 'string') return null;
  const slash = header.indexOf('/');
  if (slash <= 0) return null;
  const platform = header.slice(0, slash).trim().toLowerCase();
  const version = header.slice(slash + 1).trim();
  if (!version) return null;
  if (!(CLIENT_PLATFORMS as readonly string[]).includes(platform)) return null;
  return { platform: platform as ClientPlatform, version };
}

/**
 * Compare two dotted numeric versions. Returns -1 / 0 / 1. Missing segments are
 * treated as 0 (so `1.4` == `1.4.0`); non-numeric segments compare as 0.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number.parseInt(pa[i] ?? '0', 10) || 0;
    const nb = Number.parseInt(pb[i] ?? '0', 10) || 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

/**
 * Whether a parsed client meets its platform's minimum. An unparseable header
 * is unsupported. The api service calls this and, when false, returns the
 * `UNSUPPORTED_CLIENT_MESSAGE` with a 426 Upgrade Required.
 */
export function isSupportedClient(header: string | null | undefined): boolean {
  const parsed = parseClientVersion(header);
  if (!parsed) return false;
  const floor = MIN_SUPPORTED_CLIENT[parsed.platform];
  return compareVersions(parsed.version, floor) >= 0;
}
