/**
 * How long a note may be, and what a recording at the limit is charged (RELEASE.md rev 11, LM1).
 *
 * The apps stop at the plan's limit, but the audio they upload measures a fraction over it: container
 * framing, encoder padding and timer rounding (a 4-hour recording measured 14,400.3 s). A check with no slack
 * refused every recording that hit the limit, after the meeting. A minute of slack absorbs that, and a
 * recording inside it is charged the limit, never a minute more.
 */
export const LENGTH_SLACK_SEC = 60;

/** Whether a recording of `sec` fits a note on a plan whose longest is `maxSec`. */
export function withinLength(sec: number, maxSec: number): boolean {
  return sec <= maxSec + LENGTH_SLACK_SEC;
}

/** The minutes a recording of `sec` is charged: partial minutes round up, and no more than the plan's limit. */
export function chargedMinutes(sec: number, maxSec: number): number {
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  return Math.min(Math.ceil(sec / 60), Math.ceil(maxSec / 60));
}
