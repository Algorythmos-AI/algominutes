// Fetching a recording's media from Recall (docs/plans/MEETINGS.md "SSRF protection on the download"): HTTPS
// only, hosts on an allowlist, no redirect to another host, a size cap and a timeout. The URLs are presigned
// (they carry credentials in the query), so none is ever logged or stored; a fresh one is fetched from Recall
// at ingest.
import { Transform } from 'node:stream';

/**
 * Where Recall serves media from: `.recall.ai`, and the S3 hosts its presigned URLs point at (virtual-hosted,
 * global or in the bot's region; never the rest of amazonaws.com, where a hostname can name any EC2 address).
 * The M0 spike confirms the exact hosts for the region, and RECALL_MEDIA_HOSTS (comma-separated; a leading dot
 * is a suffix, otherwise an exact host) replaces them.
 */
export const DEFAULT_MEDIA_HOSTS = ['.recall.ai', '.s3.amazonaws.com'];

export class MediaError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'MediaError';
    this.status = status;
  }
}

export function mediaHosts(env = process.env) {
  const configured = String(env.RECALL_MEDIA_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (configured.length) return configured;
  const region = String(env.RECALL_REGION || '').toLowerCase();
  return /^[a-z]{2}-[a-z]+-\d$/.test(region) ? [...DEFAULT_MEDIA_HOSTS, `.s3.${region}.amazonaws.com`] : DEFAULT_MEDIA_HOSTS;
}

/** The URL, if it may be fetched: HTTPS on port 443, no user info, a host on the list. Else null. */
export function allowedMediaUrl(raw, hosts) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    // silent-catch-ok: a string that isn't a URL is simply not allowed; the caller says so
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  const host = u.hostname.toLowerCase();
  const ok = hosts.some((h) => (h.startsWith('.') ? host.endsWith(h) && host.length > h.length : host === h));
  return ok ? u : null;
}

/**
 * Open a media URL: the response, once it's a 2xx within the size cap. Redirects are followed by hand, and only
 * to the same host (a presigned URL can hop within S3's own host; never elsewhere).
 */
export async function openMedia(raw, { hosts, fetchImpl = globalThis.fetch, timeoutMs = 10 * 60 * 1000, maxBytes, maxRedirects = 3 }) {
  let url = allowedMediaUrl(raw, hosts);
  if (!url) throw new MediaError('media URL not allowed');
  const signal = AbortSignal.timeout(timeoutMs);
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const res = await fetchImpl(url.href, { redirect: 'manual', signal });
    if (res.status >= 300 && res.status < 400) {
      await discard(res);
      const location = res.headers.get('location');
      const next = location ? allowedMediaUrl(new URL(location, url).href, hosts) : null;
      if (!next || next.hostname !== url.hostname) throw new MediaError('media redirect to another host refused', { status: res.status });
      url = next;
      continue;
    }
    if (!res.ok) {
      await discard(res);
      throw new MediaError(`media HTTP ${res.status}`, { status: res.status });
    }
    const length = Number(res.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) {
      await discard(res);
      throw new MediaError('media larger than allowed');
    }
    return res;
  }
  throw new MediaError('media redirected too many times');
}

// A response we won't read: released, so its connection isn't held until GC.
async function discard(res) {
  try {
    await res.body?.cancel();
  } catch {
    // silent-catch-ok: the response is refused either way; a body that won't cancel is left to GC
  }
}

/** A pass-through that fails once more than maxBytes have gone through it, and counts them. */
export function byteCap(maxBytes) {
  let seen = 0;
  const t = new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      if (seen > maxBytes) cb(new MediaError('media larger than allowed'));
      else cb(null, chunk);
    },
  });
  t.bytes = () => seen;
  return t;
}

/** A small JSON media file (the participants, the speaker timeline), capped. */
export async function readJsonMedia(raw, opts) {
  const res = await openMedia(raw, opts);
  const reader = res.body.getReader();
  const chunks = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.length;
    if (seen > opts.maxBytes) {
      await reader.cancel();
      throw new MediaError('media larger than allowed');
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'));
  } catch (err) {
    // Not JSON.parse's own message: it quotes the text, which here is people's names.
    if (err instanceof SyntaxError) throw new MediaError('media is not JSON');
    throw err;
  }
}
