// A speech-to-text file that failed fails its chunk (RELEASE.md rev 11, found 2026-10-01). A batchRecognize job can
// finish (done, no operation error) while its one file failed: no read access to the chunk, or audio it can't
// decode. The file's error sat in results[uri].error, flattenWords found no words, and the chunk was saved as
// silence: a gap in the transcript with nothing wrong logged. A file's error is the chunk's error. Run with
// `node --test`; no network, no GCP (a fake operations client stands in for Speech-to-Text).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const stt = require('../src/stt.js');
const { BatchRecognizeResponse } = require('@google-cloud/speech/build/protos/protos').google.cloud.speech.v2;

const fakeClient = (op) => ({ operationsClient: { getOperation: async () => [op] } });

test("a finished job whose file failed is the chunk's error, not an empty transcript", async () => {
  const value = BatchRecognizeResponse.encode(BatchRecognizeResponse.create({
    results: { 'gs://b/transcoder/n1/chunk-0.flac': { error: { code: 7, message: 'Service account … does not have storage.objects.get access' } } },
  })).finish();
  const out = await stt.checkOperation('operations/x', fakeClient({ done: true, response: { value } }));
  assert.equal(out.done, true);
  assert.equal(out.error.code, 7);
  assert.match(out.error.message, /storage\.objects\.get/);
});

test('a finished job whose file succeeded has no error', async () => {
  const value = BatchRecognizeResponse.encode(BatchRecognizeResponse.create({
    results: { 'gs://b/c.flac': { transcript: { results: [] } } },
  })).finish();
  const out = await stt.checkOperation('operations/x', fakeClient({ done: true, response: { value } }));
  assert.equal(out.error, null);
});
