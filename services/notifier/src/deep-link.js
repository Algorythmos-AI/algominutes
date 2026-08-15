'use strict';

// Canonical deep link into a note. Matches the iOS internal URL scheme and the
// contract in packages/contracts/src/schemas/async.ts (`noteDeepLink`). The
// contract is authored in TypeScript + zod and is not require()-able from a CJS
// Cloud Run service, so the shape is mirrored here — keep the two in lockstep.
function noteDeepLink(noteId) {
  return `algominutes://note/${noteId}`;
}

module.exports = { noteDeepLink };
