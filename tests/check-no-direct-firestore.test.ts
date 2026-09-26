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
    ["batch.delete(fs.doc(`workspaces/${w}/notes/${id}`))", 'a batched delete (the doc ref is the argument)'],
    ["tx.set(noteRef, { status: 'ready' })", 'a transactional set'],
    ["t.update(\n  db.doc(p),\n  { status: 'x' },\n)", 'a transactional update split across lines'],
    ["bulkWriter.create(db.doc(p), {})", 'a bulk write'],
    ["await ref.set(patch, { merge: true })", "a bare `ref` variable (the old /Ref$/ missed it)"],
    ["await snap.ref.update({ status: 'x' })", 'a snapshot .ref'],
    ["// firestore-write-ok:\nref.set({})", 'a marker with no reason does not count'],
    ["await setDoc(doc(db, 'workspaces', w, 'notes', n), { status: 'error' })", "the web SDK's setDoc"],
    ["await updateDoc(noteRef, { title })", "the web SDK's updateDoc"],
    ["deleteDoc(\n  ref,\n)", "the web SDK's deleteDoc, split across lines"],
    ["await addDoc(collection(db, 'x'), {})", "the web SDK's addDoc"],
    ["const b = writeBatch(db);", "a web SDK batch"],
    ["await runTransaction(db, async (tx) => {})", "a web SDK transaction"],
  ])('flags %s (%s)', (src) => {
    expect(hits(src)).toBe(1);
  });

  it.each([
    ["const snap = await noteRef.get();", 'reads'],
    ["const snap = await getDoc(doc(db, 'workspaces', w)); onSnapshot(q, cb);", "web SDK reads and listeners"],
    ["await markQueued(db, input, log);", 'repo calls'],
    ["map.set(k, v); cache.delete(k);", 'unrelated set/delete'],
    ["await db.collection('analytics').add({ event })", 'appending an analytics event'],
    ["const snap = await tx.get(limitRef);", 'transactional reads'],
    ["seen.delete(item); params.set('q', v);", 'set/delete whose argument is not a doc ref'],
    ["tx.set(limitRef, {}); // firestore-write-ok: rate-limit counter, not a note", 'a reasoned marker on the line'],
    ["// firestore-write-ok: rate-limit counter, not a note\ntx.set(limitRef, {})", 'a reasoned marker on the line above'],
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
