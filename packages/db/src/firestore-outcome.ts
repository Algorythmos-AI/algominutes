// What a refused conditional Firestore update means (mirror-repair.ts, RELEASE.md PR 30c, audit Q23).
// The repair writes with a lastUpdateTime precondition, so it never overwrites a newer mirror. Firestore
// refuses such a write with a gRPC code; these are pinned against the Firestore emulator in CI
// (tests/rules/firestore-codes.test.ts):
//   - 9 FAILED_PRECONDITION: the doc changed since it was read (a newer mirror): 'moved';
//   - 5 NOT_FOUND: the doc is gone (the note was deleted): 'gone'.
// Anything else is a real failure (null), and the caller throws it.

export type RefusedUpdate = 'moved' | 'gone';

export function refusedUpdateOutcome(err: unknown): RefusedUpdate | null {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (!e) return null;
  const message = String(e.message ?? '');
  if (e.code === 9 || /FAILED_PRECONDITION/.test(message)) return 'moved';
  if (e.code === 5 || /\bNOT_FOUND\b/.test(message)) return 'gone';
  return null;
}
