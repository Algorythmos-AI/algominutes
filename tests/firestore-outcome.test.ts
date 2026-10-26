import { describe, it, expect } from 'vitest';
import { refusedUpdateOutcome } from '../packages/db/src/firestore-outcome';

// RELEASE.md PR 30c: how mirror repair reads a refused conditional update (the codes are pinned against
// the Firestore emulator in tests/rules/firestore-codes.test.ts).
describe('a refused conditional Firestore update', () => {
  it('is moved (9), gone (5), or a real failure', () => {
    expect(refusedUpdateOutcome({ code: 9 })).toBe('moved');
    expect(refusedUpdateOutcome({ message: '9 FAILED_PRECONDITION: the stored version does not match' })).toBe('moved');
    expect(refusedUpdateOutcome({ code: 5 })).toBe('gone');
    expect(refusedUpdateOutcome({ message: '5 NOT_FOUND: No document to update' })).toBe('gone');
    for (const err of [{ code: 14 }, { code: 7, message: 'PERMISSION_DENIED' }, new Error('socket hang up'), null, undefined]) {
      expect(refusedUpdateOutcome(err), String(err && (err as { code?: number }).code)).toBeNull();
    }
  });
});
