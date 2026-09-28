// Recall.ai's REST API, the calls the notetaker makes (docs/plans/MEETINGS.md).
//
// One account per environment, in one region (Recall has no Australian region;
// ours is ap-northeast-1). Every call has a timeout, and an error keeps
// Recall's status and Retry-After, so a task can tell "try again later" (409 an
// idempotent request still running, 429 rate limited, 507 no ad-hoc bots free,
// 5xx) and "this will never work" (4xx) apart.
//   https://docs.recall.ai/reference/bot_create.md, bot_list.md, bot_retrieve.md
export class RecallError extends Error {
  constructor(message, { status, retryAfterSeconds = null, body = '', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'RecallError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    // Kept for diagnosis in a debugger, never enumerable: a refused request's
    // body can quote what we sent (a meeting link), so nothing may serialise it.
    Object.defineProperty(this, 'body', { value: body, enumerable: false });
  }

  /** Worth retrying: an idempotent create still running, a rate limit, no free bots, or Recall's own fault. */
  get transient() {
    return this.status === 409 || this.status === 429 || this.status === 507 || this.status >= 500 || this.status === 0;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

export function recallBaseUrl(region) {
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(String(region || ''))) throw new Error(`recall: bad region ${region}`);
  return `https://${region}.recall.ai`;
}

export function createRecallClient({ apiKey, region, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!apiKey) throw new Error('recall: no API key');
  const base = recallBaseUrl(region);

  async function call(method, path, { body, idempotencyKey, query } = {}) {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    const headers = { Authorization: `Token ${apiKey}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let res;
    try {
      res = await fetchImpl(`${base}${path}${qs}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // A timeout or a dropped connection: Recall may or may not have acted,
      // which is why every create is adopt-or-create.
      // The cause's code (ENOTFOUND, ECONNRESET, a TLS error) goes in the
      // message, which is what the logger keeps.
      const kind = err?.name === 'TimeoutError' ? 'timed out' : 'network error';
      const cause = String(err?.cause?.code || err?.code || err?.cause?.message || err?.message || '').slice(0, 80);
      throw new RecallError(`recall ${method} ${path}: ${kind}${cause && kind !== 'timed out' ? ` (${cause})` : ''}`, { status: 0, cause: err });
    }
    if (res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) {
      const ra = Number(res.headers?.get?.('retry-after'));
      throw new RecallError(`recall ${method} ${path}: HTTP ${res.status}`, {
        status: res.status,
        retryAfterSeconds: Number.isFinite(ra) && ra >= 0 ? ra : null,
        // Recall's error bodies are about our request, never a recording; still, keep them short.
        body: text.slice(0, 300),
      });
    }
    return text ? JSON.parse(text) : null;
  }

  return {
    /** POST /api/v1/bot/. The Idempotency-Key holds for about an hour only. */
    createBot: (params, idempotencyKey) => call('POST', '/api/v1/bot/', { body: params, idempotencyKey }),
    /** Bots whose metadata[key] is value: how a replayed create finds a bot it already made. */
    findBotsByMetadata: async (key, value) => {
      const page = await call('GET', '/api/v1/bot/', { query: { [`metadata__${key}`]: value } });
      return Array.isArray(page?.results) ? page.results : [];
    },
    getBot: (id) => call('GET', `/api/v1/bot/${encodeURIComponent(id)}/`),
    /** A bot not yet dispatched can be deleted; once it's joining, Recall refuses (405) and it must leave instead. */
    deleteBot: (id) => call('DELETE', `/api/v1/bot/${encodeURIComponent(id)}/`),
    leaveCall: (id) => call('POST', `/api/v1/bot/${encodeURIComponent(id)}/leave_call/`, { body: {} }),
    /** Irreversible: removes Recall's copy of every recording the bot made. */
    deleteMedia: (id) => call('POST', `/api/v1/bot/${encodeURIComponent(id)}/delete_media/`, { body: {} }),
  };
}

/**
 * Recall's bot-create body for one of our notetakers. Everything explicit: the
 * defaults record video and keep media forever.
 */
export function botCreateParams({ meetingUrl, botName, meetingBotId, workspaceId, env, reservedMinutes, notice, retentionHours = 72 }) {
  return {
    meeting_url: meetingUrl,
    bot_name: String(botName).slice(0, 100),
    metadata: { meeting_bot_id: meetingBotId, workspace_id: workspaceId, env },
    recording_config: {
      audio_mixed_mp3: {},
      video_mixed_mp4: null,
      participant_events: {},
      // A backstop only: ingest deletes Recall's copy as soon as ours is safe.
      retention: { type: 'timed', hours: retentionHours },
    },
    automatic_leave: {
      waiting_room_timeout: 600, // Google Meet's maximum
      noone_joined_timeout: 600,
      everyone_left_timeout: { timeout: 60 },
      recording_permission_denied_timeout: 30,
      // The reservation: the bot leaves when the minutes it was sent with run out.
      in_call_recording_timeout: Math.max(60, Math.round(reservedMinutes * 60)),
    },
    chat: {
      on_bot_join: { send_to: 'everyone', message: notice, pin: true },
      on_participant_join: { message: notice, exclude_host: false },
    },
  };
}
