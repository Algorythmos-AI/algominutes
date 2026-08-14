import { Capacitor, CapacitorHttp } from './native-shim/core';
import { auth } from '../firebase';
import { apiUrl } from './apiUrl';

/**
 * Called when the backend rejects our token twice in a row.
 *
 * Nothing in `src/` handled a 401. Every endpoint returns one for a missing or
 * invalid token, so a revoked account or a badly skewed device clock produced
 * "Could not queue your recording. Please try again." on every attempt while
 * the user stayed apparently signed in — an unrecoverable state that looked
 * like a transient one.
 */
let onAuthExpired: (() => void) | null = null;
export function setAuthExpiredHandler(fn: (() => void) | null): void {
  onAuthExpired = fn;
}

// Same-origin POST with the user's Firebase ID token attached. Throws
// if no user is signed in, since every backend endpoint requires auth.
export async function authedFetch(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  const resp = await requestOnce(path, body, signal, false);
  if (resp.status !== 401) return resp;

  // A single 401 is not proof the session is dead — the cached token may have
  // simply expired. Force a refresh and try once more before concluding
  // anything, so an ordinary hour-old token does not sign a doctor out
  // mid-consultation.
  console.warn(`[api] authedFetch:401 path=${path} — refreshing token and retrying once`);
  const retry = await requestOnce(path, body, signal, true);
  if (retry.status === 401) {
    console.error(`[api] authedFetch:401_after_refresh path=${path} — session is not recoverable`);
    onAuthExpired?.();
  }
  return retry;
}

async function requestOnce(
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  forceRefresh: boolean,
): Promise<Response> {
  if (!auth.currentUser) throw new Error('Not signed in');
  const idToken = await auth.currentUser.getIdToken(forceRefresh);
  const url = apiUrl(path);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${idToken}`,
  };
  const platform = Capacitor.getPlatform();
  const payloadSummary = {
    noteId: typeof body.noteId === 'string' ? body.noteId : '',
    type: typeof body.type === 'string' ? body.type : '',
    hasStoragePath: typeof body.storagePath === 'string',
    hasSourceUrl: typeof body.sourceUrl === 'string',
  };

  console.info(
    `[api] authedFetch:start platform=${platform} path=${path} url=${url} ` +
    `noteId=${payloadSummary.noteId} type=${payloadSummary.type} ` +
    `hasStoragePath=${payloadSummary.hasStoragePath} hasSourceUrl=${payloadSummary.hasSourceUrl}`,
  );

  if (platform !== 'web') {
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    let resp;
    try {
      resp = await CapacitorHttp.request({
        url,
        method: 'POST',
        headers,
        data: body,
        responseType: 'text',
        connectTimeout: 20_000,
        readTimeout: 20_000,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = typeof err === 'object' && err && 'code' in err ? String((err as { code?: unknown }).code) : '';
      console.error(`[api] authedFetch:error platform=${platform} path=${path} url=${url} code=${code} message=${message}`);
      throw err;
    }
    console.info(`[api] authedFetch:response platform=${platform} path=${path} url=${url} status=${resp.status}`);
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    const responseBody = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data ?? '');
    return new Response(responseBody, {
      status: resp.status,
      headers: new Headers(resp.headers),
    });
  }

  // The web branch had no timeout at all, while the native branch above has
  // had 20s connect/read since it was written. A hung kickoff therefore never
  // settled: the promise stayed pending, pendingNoteType was never cleared, and
  // the note sat in 'processing' with the UI insisting it was working.
  //
  // The caller's own signal still wins if it fires first.
  const timeout = AbortSignal.timeout(WEB_REQUEST_TIMEOUT_MS);
  const combined = signal ? anySignal([signal, timeout]) : timeout;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: combined,
    });
    console.info(`[api] authedFetch:response platform=${platform} path=${path} url=${url} status=${resp.status}`);
    return resp;
  } catch (err) {
    // Distinguish "we gave up" from "the user navigated away", because the
    // callers treat a user-initiated abort as a non-error.
    if (timeout.aborted && !signal?.aborted) {
      console.error(`[api] authedFetch:timeout platform=${platform} path=${path} url=${url}`);
      throw new DOMException(`Request to ${path} timed out.`, 'TimeoutError');
    }
    throw err;
  }
}

/** Matches the native branch's 20s connect/read budget. */
export const WEB_REQUEST_TIMEOUT_MS = 20_000;

/**
 * First of several signals to abort wins. `AbortSignal.any` is not available
 * in every browser this app supports, so this is the small hand-rolled form.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}
