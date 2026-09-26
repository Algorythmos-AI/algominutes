// What the app does when POST /v1/process refuses a kickoff: the web twin of
// iOS KickoffFailure.swift. A 202 is a success (the note is already in flight).
import type { EntitlementResponse } from '@algominutes/contracts';
import { ApiError } from '../api/errors';

export type KickoffFailure =
  | { kind: 'quota'; entitlement: EntitlementResponse | null }
  | { kind: 'update_required' }
  /** 413 or 429: the server already marked the note failed, Postgres first, with this message. */
  | { kind: 'refused'; message: string }
  /** 404, network, 5xx: the client marks the note itself. */
  | { kind: 'failed'; message: string };

export const NOT_FOUND_MESSAGE = "We couldn't find this recording's audio. Please try again.";
export const UPDATE_MESSAGE = 'Please reload AlgoMinutes, then try again.';

export function kickoffFailure(err: unknown, fallback: string): KickoffFailure {
  if (err instanceof ApiError) {
    if (err.kind === 'quota_exceeded') return { kind: 'quota', entitlement: err.entitlement };
    if (err.kind === 'update_required') return { kind: 'update_required' };
    // The server's own sentence when it sent one (it does on these refusals, e.g. "That file is too
    // large. The current limit is 500 MB."), else ours; never a bare code like rate_limited.
    if (err.kind === 'too_large' || err.kind === 'rate_limited') return { kind: 'refused', message: err.code && err.code.includes(' ') ? err.code : err.message };
    if (err.kind === 'not_found') return { kind: 'failed', message: NOT_FOUND_MESSAGE };
  }
  return { kind: 'failed', message: fallback };
}

/** The first instant of the month after a "YYYY-MM" billing period (the server meters calendar months in UTC). */
export function nextPeriodStart(billingPeriod: string): Date | null {
  const m = /^(\d{4})-(\d{2})$/.exec(billingPeriod);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
}

/** The quota message without a paywall (nothing is sold in the beta): when the minutes come back, or where to ask. */
export function quotaMessage(e: EntitlementResponse | null): string {
  if (!e || e.includedMinutes == null || e.includedMinutes <= 0) {
    return "Processing isn't included on your account right now. You can reach us at support@algorythmos.com.";
  }
  const minutes = Math.round(e.includedMinutes).toLocaleString('en-AU');
  const reset = nextPeriodStart(e.billingPeriod);
  if (!reset) return `You've used this month's ${minutes} included minutes. They reset at the start of next month.`;
  const day = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(reset);
  return `You've used this month's ${minutes} included minutes. They reset on ${day}.`;
}

export function failureMessage(f: KickoffFailure): string {
  switch (f.kind) {
    case 'quota':
      return quotaMessage(f.entitlement);
    case 'update_required':
      return UPDATE_MESSAGE;
    case 'refused':
    case 'failed':
      return f.message;
  }
}

/** The error the client writes on the note, or null when the server already recorded the failure. */
export const noteError = (f: KickoffFailure): string | null => (f.kind === 'refused' ? null : failureMessage(f));
