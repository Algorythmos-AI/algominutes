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
