// Where a tapped notification goes: its note, in this environment's web app.
// Shared by the service worker (src/sw.ts) and its tests.

/**
 * The note a push is about, from its data however FCM wrapped it: our own
 * `{ noteId }`, or the `{ FCM_MSG: { data: { noteId } } }` FCM gives a
 * notification it displayed. Anything that isn't a plain id is ignored, so a
 * payload can never steer the tab somewhere else.
 */
export function noteIdOf(data: unknown): string | null {
  const d = (data ?? {}) as { noteId?: unknown; FCM_MSG?: { data?: { noteId?: unknown } } };
  const id = d.FCM_MSG?.data?.noteId ?? d.noteId;
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

/**
 * The page a tap opens: `<scope>notes/<id>`, or the notes list. Relative to the
 * worker's own scope, so staging opens staging and production production,
 * whatever link the server sent (that one is iOS's algominutes://note/<id>).
 */
export function noteUrl(scope: string, data: unknown): string {
  const id = noteIdOf(data);
  return new URL(id ? `notes/${id}` : '', scope).href;
}

/** The app's windows among a worker's clients: the scope itself (`/app/`), below it, or the notes list at `/app`. */
export function inApp(url: string, scope: string): boolean {
  return url.startsWith(scope) || url === scope.replace(/\/$/, '') || url.startsWith(`${scope.replace(/\/$/, '')}?`);
}

type Win = { url: string; focused: boolean; visibilityState: DocumentVisibilityState };

/** The app window a tap should go to: the one in front, else a visible one, else any; null opens a new one. */
export function pickWindow<W extends Win>(wins: readonly W[], scope: string): W | null {
  const app = wins.filter((w) => inApp(w.url, scope));
  return app.find((w) => w.focused) ?? app.find((w) => w.visibilityState === 'visible') ?? app[0] ?? null;
}

/** A notification the notifier sent (FCM's web push payload), or null for anything else (left to Firebase). */
export interface PushNotice {
  title: string;
  body: string;
  noteId: string | null;
  /** The payload as FCM delivered it, kept on the notification like Firebase's own. */
  raw: unknown;
}

export function parsePush(json: unknown): PushNotice | null {
  const p = json as { notification?: { title?: unknown; body?: unknown }; data?: unknown } | null;
  if (!p || typeof p !== 'object' || !p.notification || typeof p.notification !== 'object') return null;
  const title = typeof p.notification.title === 'string' ? p.notification.title : 'AlgoMinutes';
  const body = typeof p.notification.body === 'string' ? p.notification.body : '';
  return { title, body, noteId: noteIdOf(p.data), raw: p };
}

/** Messages from the worker to the app's windows. */
export type WorkerMessage = { type: 'algominutes:push'; title: string; body: string; noteId: string | null } | { type: 'algominutes:open-note'; noteId: string | null };

export function workerMessage(data: unknown): WorkerMessage | null {
  const d = data as { type?: unknown; title?: unknown; body?: unknown; noteId?: unknown } | null;
  if (!d || typeof d !== 'object') return null;
  const noteId = noteIdOf(d);
  if (d.type === 'algominutes:open-note') return { type: d.type, noteId };
  if (d.type === 'algominutes:push' && typeof d.title === 'string' && typeof d.body === 'string') return { type: d.type, title: d.title, body: d.body, noteId };
  return null;
}
