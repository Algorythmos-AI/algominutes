// The web app's one way to the server: every /v1 call, typed by
// @algominutes/contracts, the web twin of iOS APIClient.
//
// Each request carries:
//   - Authorization: the user's Firebase ID token (a 401 refreshes it once and retries);
//   - X-AlgoMinutes-Client: web/<version> (the api answers 400 without it, 426 when too old);
//   - X-Trace-Id: a fresh id, kept on any ApiError, so a failure is findable in the server's logs.
// Every 2xx body is checked against its contract schema; a body that doesn't
// match is an 'invalid_response' error, never a half-typed object.
import { z } from 'zod';
import {
  AcceptTermsRequest,
  AppConfigResponse,
  ChatCitationsEvent,
  ChatErrorEvent,
  ChatRequest,
  ChatTextEvent,
  CheckoutSessionRequest,
  CheckoutSessionResponse,
  ClientErrorReport,
  CompleteUploadResponse,
  CreateUploadSessionRequest,
  CreateUploadSessionResponse,
  DeleteAccountResponse,
  DeleteNoteRequest,
  DeleteNoteResponse,
  EntitlementResponse,
  ExportNoteRequest,
  NoteAudioUrlRequest,
  NoteAudioUrlResponse,
  NoteFeedbackRequest,
  NoteFeedbackResponse,
  NoteReadPageResponse,
  NoteReadRequest,
  NoteReadResponse,
  OkResponse,
  PortalSessionResponse,
  ProcessCachedResponse,
  ProcessInFlightResponse,
  ProcessQueuedResponse,
  ProcessRequest,
  RegenerateSummaryRequest,
  RegenerateSummaryResponse,
  RegisterPushTokenRequest,
  SearchRequest,
  SearchResponse,
  SetNoteSpeakersRequest,
  SetNoteSpeakersResponse,
  SetRetentionRequest,
  ShareCreateRequest,
  ShareCreateResponse,
  SharedNoteRequest,
  SharedNoteResponse,
  ShareRevokeRequest,
  ShareRevokeResponse,
  SupportCreatedResponse,
  SupportRequest,
  TrackEventRequest,
  UpdateNoteRequest,
  UpdateNoteResponse,
  UploadSessionStatus,
} from '@algominutes/contracts';
import { CLIENT_HEADER_VALUE, type ApiOrigins } from './config';
import { ApiError, errorFor } from './errors';
import { readSse } from './sse';

export interface ApiClientOptions {
  origins: ApiOrigins;
  /** The signed-in user's ID token, or null when nobody is signed in. `forceRefresh` after a 401. */
  getIdToken: (forceRefresh: boolean) => Promise<string | null>;
  fetch?: typeof fetch;
  newTraceId?: () => string;
  /** Called on any 426, so the app can show its "please reload" banner wherever it happens. */
  onUpdateRequired?: () => void;
  /** Per-request timeout; uploads and chat pass their own. */
  timeoutMs?: number;
}

type Backend = 'api' | 'billing';

/** A failed fetch as an ApiError: the caller's abort, our timeout, or no network. */
function transportError(err: unknown, traceId: string): ApiError {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  if (name === 'TimeoutError') return new ApiError('timeout', { traceId, cause: err });
  if (name === 'AbortError') return new ApiError('cancelled', { traceId, cause: err });
  return new ApiError('network', { traceId, cause: err });
}

/** The Firebase ID token, or an ApiError: a refresh can fail offline, or when the account was revoked. */
async function tokenOrError(getIdToken: ApiClientOptions['getIdToken'], forceRefresh: boolean, traceId: string): Promise<string> {
  let token: string | null;
  try {
    token = await getIdToken(forceRefresh);
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
    throw new ApiError(code === 'auth/network-request-failed' ? 'network' : 'not_signed_in', { traceId, cause: err });
  }
  if (!token) throw new ApiError('not_signed_in', { traceId });
  return token;
}

interface Call<S extends z.ZodType> {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  backend?: Backend;
  /** false for the public endpoints (shares/read, client-error). */
  auth?: boolean;
  schema: S;
  timeoutMs?: number;
  /** The caller's own abort (a Stop button). */
  signal?: AbortSignal;
}

export type ChatEvent =
  | { type: 'citations'; hits: ChatCitationsEvent['hits'] }
  | { type: 'text'; text: string }
  | { type: 'done' }
  | { type: 'error'; error: string };

const ProcessResponse = ProcessQueuedResponse.or(ProcessCachedResponse).or(ProcessInFlightResponse);
const NoteRead = NoteReadResponse.or(NoteReadPageResponse);
/** A 204: no body. */
const NoContent = z.undefined();

export function createApiClient(opts: ApiClientOptions) {
  const doFetch = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const newTraceId = opts.newTraceId ?? (() => crypto.randomUUID());
  const defaultTimeout = opts.timeoutMs ?? 20_000;

  /** Sends one request, refreshing the token once on a 401. Returns the raw 2xx response. */
  async function send(call: Omit<Call<z.ZodType>, 'schema'>, accept = 'application/json'): Promise<{ res: Response; traceId: string }> {
    const traceId = newTraceId();
    const auth = call.auth ?? true;
    const url = `${opts.origins[call.backend ?? 'api']}${call.path}`;
    const attempt = async (forceRefresh: boolean): Promise<Response> => {
      const headers: Record<string, string> = {
        Accept: accept,
        'X-AlgoMinutes-Client': CLIENT_HEADER_VALUE,
        'X-Trace-Id': traceId,
      };
      if (auth) headers.Authorization = `Bearer ${await tokenOrError(opts.getIdToken, forceRefresh, traceId)}`;
      if (call.body !== undefined) headers['Content-Type'] = 'application/json';
      try {
        return await doFetch(url, {
          method: call.method,
          headers,
          body: call.body === undefined ? undefined : JSON.stringify(call.body),
          signal: call.signal
            ? AbortSignal.any([AbortSignal.timeout(call.timeoutMs ?? defaultTimeout), call.signal])
            : AbortSignal.timeout(call.timeoutMs ?? defaultTimeout),
          credentials: 'omit',
        });
      } catch (err) {
        throw transportError(err, traceId);
      }
    };
    let res = await attempt(false);
    if (res.status === 401 && auth) res = await attempt(true);
    if (!res.ok) {
      const body = await res.text().then(parseJson, () => null);
      const error = errorFor(res.status, body, res.headers, traceId);
      if (error.kind === 'update_required') opts.onUpdateRequired?.();
      throw error;
    }
    return { res, traceId };
  }

  async function json<S extends z.ZodType>(call: Call<S>): Promise<z.infer<S>> {
    const { res, traceId } = await send(call);
    const body = await res.text().then(parseJson, (err: unknown) => {
      throw transportError(err, traceId);
    });
    const parsed = call.schema.safeParse(body);
    if (!parsed.success) throw new ApiError('invalid_response', { status: res.status, body, traceId, cause: parsed.error });
    return parsed.data;
  }

  const post = <S extends z.ZodType>(path: string, body: unknown, schema: S, extra: Partial<Call<S>> = {}) =>
    json({ method: 'POST', path, body, schema, ...extra });
  const get = <S extends z.ZodType>(path: string, schema: S) => json({ method: 'GET', path, schema });

  return {
    // Account, plan and app settings
    entitlement: () => get('/v1/entitlement', EntitlementResponse),
    appConfig: () => get('/v1/config', AppConfigResponse),
    acceptTerms: (body: AcceptTermsRequest) => post('/v1/account/accept-terms', body, OkResponse),
    setRetention: (body: SetRetentionRequest) => post('/v1/account/retention', body, OkResponse),
    deleteAccount: () => post('/v1/account/delete', {}, DeleteAccountResponse, { timeoutMs: 120_000 }),
    support: (body: SupportRequest) => post('/v1/support', body, SupportCreatedResponse),
    trackEvent: (body: TrackEventRequest) => post('/v1/events', body, OkResponse),
    registerPush: (body: z.infer<typeof RegisterPushTokenRequest>) => post('/v1/push/register', body, OkResponse),

    // Notes
    readNote: (body: NoteReadRequest) => post('/v1/notes/read', body, NoteRead),
    updateNote: (body: UpdateNoteRequest) => post('/v1/notes/update', body, UpdateNoteResponse),
    deleteNote: (body: DeleteNoteRequest) => post('/v1/notes/delete', body, DeleteNoteResponse),
    noteAudioUrl: (body: NoteAudioUrlRequest) => post('/v1/notes/audio-url', body, NoteAudioUrlResponse),
    setSpeakers: (noteId: string, body: SetNoteSpeakersRequest) =>
      post(`/v1/notes/${encodeURIComponent(noteId)}/speakers`, body, SetNoteSpeakersResponse),
    regenerateSummary: (body: RegenerateSummaryRequest) => post('/v1/notes/regenerate-summary', body, RegenerateSummaryResponse),
    noteFeedback: (body: NoteFeedbackRequest) => post('/v1/notes/feedback', body, NoteFeedbackResponse),
    /** The exported document (DOCX) and the file name the server gave it. */
    exportNote: async (body: ExportNoteRequest): Promise<{ blob: Blob; fileName: string | null }> => {
      const { res } = await send({ method: 'POST', path: '/v1/export', body, timeoutMs: 60_000 }, '*/*');
      const disposition = res.headers.get('content-disposition') ?? '';
      const name = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1] ?? /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? null;
      return { blob: await res.blob(), fileName: name ? safeDecode(name) : null };
    },

    // Recording and import
    createUpload: (body: CreateUploadSessionRequest) => post('/v1/uploads', body, CreateUploadSessionResponse),
    uploadStatus: (uploadId: string) => get(`/v1/uploads/${encodeURIComponent(uploadId)}`, UploadSessionStatus),
    completeUpload: (uploadId: string) => post(`/v1/uploads/${encodeURIComponent(uploadId)}/complete`, {}, CompleteUploadResponse),
    process: (body: ProcessRequest) => post('/v1/process', body, ProcessResponse, { timeoutMs: 60_000 }),

    // Search and chat
    search: (body: SearchRequest) => post('/v1/search', body, SearchResponse),
    /** The /v1/chat stream, one typed event at a time. Aborts with `signal`. */
    chat: async function* (body: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
      const { res, traceId } = await send({ method: 'POST', path: '/v1/chat', body, timeoutMs: 120_000, signal }, 'text/event-stream');
      if (!res.body) throw new ApiError('invalid_response', { status: res.status, traceId });
      try {
        for await (const frame of readSse(res.body)) {
          const data = parseJson(frame.data);
          if (frame.event === 'citations') {
            const hits = ChatCitationsEvent.safeParse(data);
            if (!hits.success) throw new ApiError('invalid_response', { traceId, body: data });
            yield { type: 'citations', hits: hits.data.hits };
          } else if (frame.event === 'done') {
            yield { type: 'done' };
            return;
          } else if (frame.event === 'error') {
            const err = ChatErrorEvent.safeParse(data);
            yield { type: 'error', error: err.success ? err.data.error : 'stream_failed' };
            return;
          } else {
            const text = ChatTextEvent.safeParse(data);
            if (text.success) yield { type: 'text', text: text.data.text };
          }
        }
      } catch (err) {
        if (err instanceof ApiError) throw err; // our own verdict on a frame (invalid_response)
        // The caller's Stop ends the stream quietly; our timeout or a dropped connection says so.
        if (signal?.aborted) return;
        yield { type: 'error', error: transportError(err, traceId).kind === 'timeout' ? 'timeout' : 'stream_ended' };
        return;
      }
      // The stream closed without `done`: the answer may be cut short.
      yield { type: 'error', error: 'stream_ended' };
    },

    // Sharing (off in the apps for now: SHARE_LINKS_ENABLED)
    createShare: (body: ShareCreateRequest) => post('/v1/shares/create', body, ShareCreateResponse),
    revokeShare: (body: ShareRevokeRequest) => post('/v1/shares/revoke', body, ShareRevokeResponse),
    readShare: (body: SharedNoteRequest) => post('/v1/shares/read', body, SharedNoteResponse, { auth: false }),

    // Billing (the billing service's own origin; not on sale in the beta)
    checkout: (body: z.infer<typeof CheckoutSessionRequest>) => post('/v1/billing/checkout', body, CheckoutSessionResponse, { backend: 'billing' }),
    portal: () => post('/v1/billing/portal', {}, PortalSessionResponse, { backend: 'billing' }),

    /** The crash beacon (public, 204). */
    reportClientError: (body: z.infer<typeof ClientErrorReport>) => post('/v1/client-error', body, NoContent, { auth: false, timeoutMs: 10_000 }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

function safeDecode(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    // silent-catch-ok: a plain file name that isn't percent-encoded (a stray %) is used as it is.
    return name;
  }
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // silent-catch-ok: not JSON (a proxy's HTML error page, say); the caller maps the status alone.
    return undefined;
  }
}
