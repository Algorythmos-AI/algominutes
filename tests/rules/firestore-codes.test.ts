import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { refusedUpdateOutcome } from '../../packages/db/src/firestore-outcome';

// RELEASE.md PR 30c (audit Q23): the codes Firestore refuses a conditional update with, as mirror repair
// relies on them, against the Firestore emulator (CI job firestore-rules; FIRESTORE_EMULATOR_HOST). The
// repair writes with a lastUpdateTime precondition so it never overwrites a newer mirror: a stale write
// must read as 'moved', and a write to a deleted doc must never read as a failure.
let app: App;
let db: Firestore;
beforeAll(() => {
  app = initializeApp({ projectId: 'demo-algominutes' }, 'firestore-codes');
  db = getFirestore(app);
});
afterAll(async () => {
  await deleteApp(app);
});

async function refusal(write: () => Promise<unknown>) {
  try {
    await write();
  } catch (err) {
    return err as { code?: number };
  }
  throw new Error('expected Firestore to refuse the write');
}

describe("Firestore's refusals, as mirror repair reads them", () => {
  it('a write whose precondition is stale is refused FAILED_PRECONDITION (9): moved', async () => {
    const ref = db.doc('workspaces/ws_codes/notes/stale');
    await ref.set({ status: 'transcribing' });
    const read = await ref.get();
    await ref.update({ status: 'ready' }); // a newer mirror lands after the read
    const err = await refusal(() => ref.update({ status: 'error' }, { lastUpdateTime: read.updateTime! }));
    expect(err.code).toBe(9);
    expect(refusedUpdateOutcome(err)).toBe('moved');
    expect((await ref.get()).data()?.status).toBe('ready'); // the newer write stands
  });

  it('a conditional write to a deleted doc is refused, and read as gone or moved, never as a failure', async () => {
    const ref = db.doc('workspaces/ws_codes/notes/deleted');
    await ref.set({ status: 'transcribing' });
    const read = await ref.get();
    await ref.delete();
    const err = await refusal(() => ref.update({ status: 'error' }, { lastUpdateTime: read.updateTime! }));
    expect([5, 9]).toContain(err.code);
    expect(refusedUpdateOutcome(err)).not.toBeNull();
    expect((await ref.get()).exists).toBe(false); // nothing re-created
  });

  it('an update without a precondition to a missing doc is NOT_FOUND (5): gone', async () => {
    const err = await refusal(() => db.doc('workspaces/ws_codes/notes/never').update({ status: 'error' }));
    expect(err.code).toBe(5);
    expect(refusedUpdateOutcome(err)).toBe('gone');
  });
});
