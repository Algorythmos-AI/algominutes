// Required client-version gate.
//
// Every client sends `X-AlgoMinutes-Client: <platform>/<semver>`
// (e.g. `ios/1.0.0`, `web/1.0.0`, `android/1.0.0`). This middleware parses it
// and, if the caller is a KNOWN platform running below the configured minimum,
// answers 426 Upgrade Required with a friendly JSON body — never a 500
// (BUILD-PLAN: "an unsupported client version receives a friendly upgrade
// prompt, not a 500").
//
// Leniency, by design:
//   - Minimums are GENEROUS (1.0.0 across the board) so no currently-shipping
//     client is ever gated. Raising a floor is a one-line edit here.
//   - An UNKNOWN platform is allowed through rather than rejected — a new
//     client we have not enumerated yet must not be locked out by this gate.
//   - A malformed header is a clear 400, not a 500.
//   - A missing header from an otherwise-unidentifiable caller is a clear 400.
//   - Parsing can never throw past this middleware.

// Constant map, generous defaults. Bump a floor here (and only here) when a
// minimum supported version needs to move.
export const MIN_SUPPORTED_CLIENTS = {
  ios: '1.0.0',
  web: '1.0.0',
  android: '1.0.0',
};

const UPGRADE_BODY = {
  error: 'please_update',
  message: 'Please update AlgoMinutes to continue.',
};

// Parse "1.2.3", "1.2.3-beta.1", "1.2.3+build" → [1, 2, 3]. Missing segments
// default to 0. Returns null when nothing numeric is present.
function parseVersion(raw) {
  const core = String(raw).trim().split(/[-+]/, 1)[0];
  const parts = core.split('.');
  const nums = [];
  for (let i = 0; i < 3; i++) {
    const n = Number(parts[i]);
    nums.push(Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);
  }
  // Reject a version with no numeric content at all (e.g. "vNext").
  if (!/\d/.test(core)) return null;
  return nums;
}

// True when version `a` is strictly older than `b` (both [maj,min,patch]).
function isOlder(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return false;
}

// Parse the header value into { platform, version } or null when it does not
// match the `<platform>/<semver>` contract.
export function parseClientHeader(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  const platform = trimmed.slice(0, slash).trim().toLowerCase();
  const versionRaw = trimmed.slice(slash + 1).trim();
  if (!/^[a-z][a-z0-9_-]*$/.test(platform)) return null;
  const version = parseVersion(versionRaw);
  if (!version) return null;
  return { platform, version, versionRaw };
}

/**
 * @param {object} [opts]
 * @param {(req) => boolean} [opts.exempt] — return true to skip the gate
 *        (e.g. the health check). OPTIONS preflight is always skipped.
 * @param {Record<string,string>} [opts.minimums] — override the min map.
 */
export function clientVersionMiddleware(opts = {}) {
  const minimums = opts.minimums || MIN_SUPPORTED_CLIENTS;
  const exempt = typeof opts.exempt === 'function' ? opts.exempt : () => false;

  // Precompute parsed minimums once.
  const minParsed = {};
  for (const [platform, ver] of Object.entries(minimums)) {
    minParsed[platform] = parseVersion(ver) || [0, 0, 0];
  }

  return function clientVersionGate(req, res, next) {
    // Preflight carries no app header; the CORS layer owns it.
    if (req.method === 'OPTIONS') return next();
    if (exempt(req)) return next();

    const header = req.headers['x-algominutes-client'];
    if (header === undefined || header === null || String(header).trim() === '') {
      return res.status(400).json({
        error: 'client_version_required',
        message: 'The X-AlgoMinutes-Client header (e.g. "web/1.0.0") is required.',
      });
    }

    let parsed = null;
    try {
      parsed = parseClientHeader(header);
    } catch {
      // Belt-and-braces: parsing must never surface as a 500.
      parsed = null;
    }
    if (!parsed) {
      return res.status(400).json({
        error: 'invalid_client_version',
        message: 'X-AlgoMinutes-Client must look like "<platform>/<version>", e.g. "web/1.0.0".',
      });
    }

    // Expose the parsed identity for downstream logging / analytics.
    req.client = { platform: parsed.platform, version: parsed.versionRaw };
    if (req.log && typeof req.log.child === 'function') {
      req.log = req.log.child({ clientPlatform: parsed.platform, clientVersion: parsed.versionRaw });
    }

    const min = minParsed[parsed.platform];
    // Unknown platform → allow (lenient): do not lock out a client we have not
    // enumerated. Only KNOWN platforms below their floor are gated.
    if (min && isOlder(parsed.version, min)) {
      if (req.log && typeof req.log.info === 'function') {
        req.log.info({ platform: parsed.platform, version: parsed.versionRaw, min: minimums[parsed.platform] }, 'client_version_gated');
      }
      // 426 Upgrade Required, friendly body, never a 500.
      return res.status(426).json(UPGRADE_BODY);
    }

    return next();
  };
}
