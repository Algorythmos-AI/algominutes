// The beta's invite codes on the web (docs/plans/RELEASE.md PR 9): the web twin
// of iOS InviteCodeSheet. A tester enters the code from their invitation; the
// server (POST /v1/beta/redeem) normalises case, spaces and dashes.
import type { EntitlementResponse, RedeemInviteResponse } from '@algominutes/contracts';
import { ApiError } from '../api/errors';

/** No minutes left, by the server's count. Unknown or unmetered counts as having minutes. */
export function noMinutesLeft(e: EntitlementResponse | null | undefined): boolean {
  return !!e && e.remainingMinutes != null && e.remainingMinutes <= 0;
}

/** What to tell the tester when a code is refused. */
export function inviteErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'invite_invalid':
        return "That code isn't valid. Check it against your invitation and try again.";
      case 'invite_expired':
        return 'That code has expired. Ask whoever invited you for a new one.';
      case 'invite_used_up':
        return 'That code has been used as many times as it allows. Ask whoever invited you for a new one.';
      default:
        break;
    }
    if (err.kind === 'rate_limited') return 'Too many tries. Wait a few minutes, then try again.';
    if (err.kind === 'network' || err.kind === 'timeout') return 'No connection. Check your internet, then try again.';
    if (err.kind === 'server') return 'Something went wrong on our side. Please try again in a minute.';
  }
  return "We couldn't add that code. Please try again.";
}

/** What the code gave: the minutes left now, and until when. */
export function inviteSuccessLine(r: RedeemInviteResponse, locale = 'en-AU'): string {
  const left = r.entitlement.remainingMinutes;
  const what = left == null ? 'Recording is on' : `You have ${Math.round(left).toLocaleString(locale)} recording minutes`;
  const tail = 'Anything that couldn’t process can be tried again now.';
  if (!r.grantEndsAt) return `${what} for this beta. ${tail}`;
  const end = new Date(r.grantEndsAt);
  if (Number.isNaN(end.getTime())) return `${what} for this beta. ${tail}`;
  const day = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long' }).format(end);
  return `${what}, until ${day}. ${tail}`;
}
