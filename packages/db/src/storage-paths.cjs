'use strict';

// Cloud Storage path validation. Accepts the two prefixes we expose to
// clients via storage.rules: recordings/{workspaceId}/... and
// imports/{workspaceId}/.... Anything else is rejected. The 512-char
// length cap prevents abuse via malicious metadata.

const ALLOWED_PREFIXES = ['recordings/', 'imports/'];

function validateStoragePath(path, workspaceId) {
  if (typeof path !== 'string') return { ok: false, reason: 'not_string' };
  if (path.length === 0 || path.length > 512) return { ok: false, reason: 'bad_length' };
  if (path.includes('..')) return { ok: false, reason: 'traversal' };

  const matchedPrefix = ALLOWED_PREFIXES.find((p) => path.startsWith(`${p}${workspaceId}/`));
  if (!matchedPrefix) return { ok: false, reason: 'bad_prefix' };

  return { ok: true, prefix: matchedPrefix.slice(0, -1) };
}

module.exports = { validateStoragePath, ALLOWED_PREFIXES };
