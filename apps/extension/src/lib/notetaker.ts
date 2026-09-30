// Sending the notetaker to the Meet the popup was opened on (RELEASE.md PR 37c, ADR 0002 §4, CONSENT.md
// §2.4). The popup reads the tab's address through the meet.google.com host permission, rather than drawing
// a button into Meet's page, which Meet's own changes would keep breaking. The bot is the web app's: the
// same POST /v1/meetings/bots, the same affirmation ticked every time, the same allowlist.
import { apiFetch, type Fetch } from './http';
import { idToken, type Deps as SessionDeps } from './session';

export interface Deps extends SessionDeps {
  fetch: Fetch;
}

/** A Google Meet meeting's own link (https://meet.google.com/abc-defg-hij), or null for anything else. */
export function meetLinkOf(url: string | undefined): string | null {
  const m = /^https:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?#]|$)/.exec(url ?? '');
  return m ? `https://meet.google.com/${m[1]}` : null;
}

/** Whether this user may send the notetaker from the extension: /v1/config's bot and extension surfaces. */
export async function notetakerAvailable(deps: Deps): Promise<boolean> {
  const token = await idToken(deps);
  if (!token) return false;
  const res = await apiFetch(deps.fetch, '/v1/config', { method: 'GET', idToken: token });
  if (!res.ok) return false;
  const n = ((await res.json()) as { notetaker?: { bot?: unknown; extension?: unknown } }).notetaker;
  return n?.bot === true && n?.extension === true;
}

export type SendResult =
  | { ok: true; noteId: string; already: boolean }
  | { ok: false; message: string };

const FALLBACK = 'The notetaker couldn’t be sent. Try again.';

/**
 * Send it. `requestId` is the popup's, kept across its retries, so a retry never sends a second notetaker;
 * one already on its way to this meeting (409) is that note.
 */
export async function sendNotetaker(deps: Deps, input: { url: string; requestId: string }): Promise<SendResult> {
  const meetingUrl = meetLinkOf(input.url);
  if (!meetingUrl) return { ok: false, message: 'Open the extension from a Google Meet meeting’s tab.' };
  const token = await idToken(deps);
  if (!token) return { ok: false, message: 'Connect the extension to your AlgoMinutes account first.' };
  const res = await apiFetch(deps.fetch, '/v1/meetings/bots', { method: 'POST', idToken: token, body: { meetingUrl, requestId: input.requestId } });
  // silent-catch-ok: a body that isn't JSON (a proxy's error page) gets the fallback sentence below
  const body = (await res.json().catch(() => null)) as { noteId?: unknown; error?: unknown; message?: unknown } | null;
  if (res.ok && typeof body?.noteId === 'string') return { ok: true, noteId: body.noteId, already: false };
  if (res.status === 409 && typeof body?.noteId === 'string') return { ok: true, noteId: body.noteId, already: true };
  if (res.status === 426) return { ok: false, message: 'This version of the extension is out of date. Update it, then try again.' };
  if (res.status === 402) return { ok: false, message: typeof body?.message === 'string' ? body.message : 'You’ve used this month’s notetaker minutes.' };
  // The server's own sentence where it has one (notetaker minutes used up, the notetaker off for now).
  const said = typeof body?.message === 'string' ? body.message : typeof body?.error === 'string' && body.error.includes(' ') ? body.error : null;
  return { ok: false, message: said ?? FALLBACK };
}
