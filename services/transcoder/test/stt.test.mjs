// checkOperation: an STT response we can't decode is a FAILED chunk, never an
// empty one. Run with `node --test`; no network, no GCP (a fake operations
// client stands in for Speech-to-Text).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const stt = require('../src/stt.js');
const { BatchRecognizeResponse } = require('@google-cloud/speech/build/protos/protos').google.cloud.speech.v2;

const fakeClient = (op) => ({ operationsClient: { getOperation: async () => [op] } });

test('an undecodable response fails the chunk instead of saving it empty', async () => {
  // Field 1, length-delimited, claims 255 bytes that are not there.
  const op = { done: true, response: { value: Buffer.from([0x0a, 0xff]) } };
  const out = await stt.checkOperation('operations/x', fakeClient(op));
  assert.equal(out.done, true);
  assert.equal(out.result, null);
  assert.equal(out.error.code, 'DECODE_FAILED');
  assert.match(out.error.message, /^stt_response_decode_failed: /);
});

test('a well-formed response decodes, with no error', async () => {
  const value = BatchRecognizeResponse.encode(BatchRecognizeResponse.create({ totalBilledDuration: { seconds: 600 } })).finish();
  const out = await stt.checkOperation('operations/x', fakeClient({ done: true, response: { value } }));
  assert.equal(out.error, null);
  assert.equal(String(out.result.totalBilledDuration.seconds), '600');
});

test('an upstream operation error is passed through unchanged', async () => {
  const opErr = { code: 3, message: 'INVALID_ARGUMENT: bad audio' };
  const out = await stt.checkOperation('operations/x', fakeClient({ done: true, error: opErr }));
  assert.deepEqual(out.error, opErr);
});
