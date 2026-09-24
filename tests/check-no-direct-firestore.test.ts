import { describe, it, expect } from 'vitest';
// @ts-expect-error: plain .mjs script, no type declarations
import { findDirectWrites, ALLOWLIST } from '../scripts/check-no-direct-firestore.mjs';

const hits = (src: string) => (findDirectWrites('x.js', src) as unknown[]).length;

describe('direct-Firestore gate (syntax-aware)', () => {
  it.each([
    ["db.doc(`workspaces/${w}/notes/${n}`).set({ status: 'x' })", 'one-line doc write'],
    ["db.doc(`workspaces/${w}/notes/${n}`)\n  .set({ status: 'summarizing' }, { merge: true })", 'split across lines (the form grep missed)'],
    ["await noteRef\n  .update({ status: 'error' })", 'a *Ref variable, multi-line'],
    ["firestore().doc(p).delete()", 'delete'],
    ["db.collection('notes').doc(id).create({})", 'create via collection().doc()'],
  ])('flags %s (%s)', (src) => {
    expect(hits(src)).toBe(1);
  });

  it.each([
    ["const snap = await noteRef.get();", 'reads'],
    ["await markQueued(db, input, log);", 'repo calls'],
    ["map.set(k, v); cache.delete(k);", 'unrelated set/delete'],
    ["await db.collection('analytics').add({ event })", 'appending an analytics event'],
  ])('allows %s (%s)', (src) => {
    expect(hits(src)).toBe(0);
  });

  it('every allowlisted file states its reason', () => {
    for (const [file, why] of ALLOWLIST as Map<string, string>) {
      expect(file).toMatch(/\.(c|m)?[jt]s$/);
      expect(why.length).toBeGreaterThan(10);
    }
  });
});
