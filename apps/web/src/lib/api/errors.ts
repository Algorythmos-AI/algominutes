// The typed failures every caller handles, mapped as iOS APIClient.httpError
// maps them, so both apps react to the same server answer the same way.
import { EntitlementResponse } from '@algominutes/contracts';

export type ApiErrorKind =
  | 'not_signed_in' // no Firebase user, or the token was refused twice
  | 'quota_exceeded' // 402 quota_exceeded: the plan's minutes are spent
  | 'update_required' // 426: this build is older than the server's minimum
  | 'not_found' // 404: the note (or share) is gone, or was never this user's
  | 'conflict' // 409: already regenerating, manual edits, and the like
  | 'too_large' // 413: an upload or export over its cap
  | 'rate_limited' // 429
  | 'bad_request' // any other 4xx
  | 'server' // 5xx
  | 'network' // no answer at all (offline, DNS, CORS)
  | 'invalid_response'; // a 2xx whose body doesn't match the contract

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  /** The body's `error` code, when there was one. */
  readonly code: string | null;
  /** The whole parsed body, for callers that read more (409's `status`, 413's limits). */
  readonly body: unknown;
  /** 402's entitlement, so the paywall can show the plan without another request. */
  readonly entitlement: EntitlementResponse | null;
  /** 429's Retry-After, in seconds. */
  readonly retryAfterSec: number | null;
  readonly traceId: string | null;

  constructor(
    kind: ApiErrorKind,
    opts: { status?: number | null; code?: string | null; body?: unknown; entitlement?: EntitlementResponse | null; retryAfterSec?: number | null; traceId?: string | null; message?: string; cause?: unknown } = {},
  ) {
    super(opts.message ?? MESSAGES[kind], opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'ApiError';
    this.kind = kind;
    this.status = opts.status ?? null;
    this.code = opts.code ?? null;
    this.body = opts.body;
    this.entitlement = opts.entitlement ?? null;
    this.retryAfterSec = opts.retryAfterSec ?? null;
    this.traceId = opts.traceId ?? null;
  }
}

/** What the user sees when a screen has nothing more specific to say. */
export const MESSAGES: Record<ApiErrorKind, string> = {
  not_signed_in: 'Please sign in again.',
  quota_exceeded: "You've used your included minutes.",
  update_required: 'Please reload to get the latest version of AlgoMinutes.',
  not_found: "That note isn't available. It may have been deleted.",
  conflict: "That can't be done right now.",
  too_large: 'That file is too large.',
  rate_limited: "You're going a little fast. Try again in a moment.",
  bad_request: 'Something about that request was wrong.',
  server: 'AlgoMinutes had a problem. Try again in a moment.',
  network: "Can't reach AlgoMinutes. Check your connection.",
  invalid_response: 'AlgoMinutes sent something unexpected. Try again.',
};

/** The error for a non-2xx answer. */
export function errorFor(status: number, body: unknown, headers: Headers, traceId: string | null): ApiError {
  const code = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : null;
  const base = { status, code, body, traceId };
  if (status === 402 && code === 'quota_exceeded') {
    const parsed = EntitlementResponse.safeParse((body as { entitlement?: unknown }).entitlement);
    return new ApiError('quota_exceeded', { ...base, entitlement: parsed.success ? parsed.data : null });
  }
  if (status === 401) return new ApiError('not_signed_in', base);
  if (status === 426) return new ApiError('update_required', base);
  if (status === 404) return new ApiError('not_found', base);
  if (status === 409) return new ApiError('conflict', base);
  if (status === 413) return new ApiError('too_large', base);
  if (status === 429) {
    const retry = Number(headers.get('retry-after'));
    return new ApiError('rate_limited', { ...base, retryAfterSec: Number.isFinite(retry) && retry > 0 ? retry : null });
  }
  if (status >= 500) return new ApiError('server', base);
  return new ApiError('bad_request', base);
}
