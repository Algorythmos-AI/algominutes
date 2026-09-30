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

// RELEASE.md rev 11, N2 (H10): speech-to-text in Sydney. Probed 2026-10-01: `long` serves batchRecognize in
// australia-southeast1 (en-AU only). A chunk already running when the location changes still polls where it
// started: its client follows the operation's own location.
test('the recognizer and the client follow STT_LOCATION, and global is the default until it is set', () => {
  const saved = { ...process.env };
  try {
    process.env.GOOGLE_CLOUD_PROJECT = 'p';
    delete process.env.STT_LOCATION;
    assert.equal(stt.defaultSystemRecognizer(), 'projects/p/locations/global/recognizers/_');
    assert.deepEqual(stt.clientOptionsFor('global'), {});
    process.env.STT_LOCATION = 'australia-southeast1';
    assert.equal(stt.defaultSystemRecognizer(), 'projects/p/locations/australia-southeast1/recognizers/_');
    assert.deepEqual(stt.clientOptionsFor('australia-southeast1'), { apiEndpoint: 'australia-southeast1-speech.googleapis.com' });
  } finally {
    process.env = saved;
  }
});

test("an operation is polled in its own location, whatever STT_LOCATION says now", () => {
  assert.equal(stt.operationLocation('projects/627/locations/australia-southeast1/operations/v2-abc'), 'australia-southeast1');
  assert.equal(stt.operationLocation('projects/627/locations/global/operations/v2-abc'), 'global');
  assert.equal(stt.operationLocation('operations/x'), 'global');
});

test("a named recognizer's own location wins over STT_LOCATION", () => {
  assert.equal(stt.operationLocation('projects/p/locations/us-central1/recognizers/r1'), 'us-central1');
});
