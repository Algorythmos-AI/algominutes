// Provider mapping tests. Run with `node --test` (Node 22 built-in runner) —
// no network, no keys, no DB. These pin the ONLY provider-specific logic that
// matters for correctness: mapping a vendor response to the neutral, global-tag
// line shape the rest of the pipeline consumes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const neutral = require('../src/providers/neutral.js');
const assemblyai = require('../src/providers/assemblyai.js');
const deepgram = require('../src/providers/deepgram.js');
const seam = require('../src/stt-provider.js');

test('speakerLabelToTag normalises every provider label shape to a 1-based tag', () => {
  // AssemblyAI: "A","B" → 1,2
  assert.equal(neutral.speakerLabelToTag('A'), 1);
  assert.equal(neutral.speakerLabelToTag('B'), 2);
  assert.equal(neutral.speakerLabelToTag('c'), 3);
  // Deepgram: 0-based int → 1-based
  assert.equal(neutral.speakerLabelToTag(0), 1);
  assert.equal(neutral.speakerLabelToTag(1), 2);
  // numeric string is treated as already 1-based
  assert.equal(neutral.speakerLabelToTag('2'), 2);
  // unknown / null falls back to 1, never null (a line must have a speaker)
  assert.equal(neutral.speakerLabelToTag(null), 1);
  assert.equal(neutral.speakerLabelToTag(''), 1);
});

test('neutral.wordsToLines groups by speaker and by >1500ms gaps', () => {
  const words = [
    { speakerTag: 1, startMs: 0, endMs: 500, text: 'hello', confidence: 0.9 },
    { speakerTag: 1, startMs: 500, endMs: 900, text: 'there', confidence: 0.8 },
    { speakerTag: 2, startMs: 1000, endMs: 1400, text: 'hi', confidence: 0.7 },
    // same speaker but a 2s gap → new line
    { speakerTag: 2, startMs: 3500, endMs: 3900, text: 'again', confidence: 0.6 },
  ];
  const lines = neutral.wordsToLines(words);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].speakerTag, 1);
  assert.equal(lines[0].startMs, 0);
  assert.equal(lines[0].endMs, 900);
  assert.equal(lines[0].text, 'hello there');
  assert.ok(Math.abs(lines[0].confidence - 0.85) < 1e-6);
  assert.equal(lines[1].text, 'hi');
  assert.equal(lines[2].text, 'again');
});

test('assemblyai.mapCompleted uses utterances, keeps ms, assigns global tags', () => {
  const resp = {
    status: 'completed',
    utterances: [
      { speaker: 'A', start: 0, end: 2000, text: 'Morning everyone.', confidence: 0.95 },
      { speaker: 'B', start: 2100, end: 4000, text: 'Morning.', confidence: 0.9 },
      // same speaker A returns later in the file — must reuse tag 1 (GLOBAL)
      { speaker: 'A', start: 60000, end: 61000, text: 'Any updates?', confidence: 0.92 },
    ],
  };
  const lines = assemblyai.mapCompleted(resp);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], { speakerTag: 1, startMs: 0, endMs: 2000, text: 'Morning everyone.', confidence: 0.95 });
  assert.equal(lines[1].speakerTag, 2);
  assert.equal(lines[2].speakerTag, 1, 'speaker A late in the file keeps tag 1 — global consistency');
});

test('assemblyai.mapCompleted falls back to words when no utterances', () => {
  const resp = {
    status: 'completed',
    words: [
      { speaker: 'A', start: 0, end: 400, text: 'one', confidence: 0.9 },
      { speaker: 'A', start: 400, end: 800, text: 'two', confidence: 0.9 },
      { speaker: 'B', start: 900, end: 1200, text: 'three', confidence: 0.9 },
    ],
  };
  const lines = assemblyai.mapCompleted(resp);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, 'one two');
  assert.equal(lines[1].speakerTag, 2);
});

test('assemblyai.mapCompleted drops empty utterances', () => {
  const lines = assemblyai.mapCompleted({ utterances: [{ speaker: 'A', start: 0, end: 1, text: '  ' }] });
  assert.equal(lines.length, 0);
});

test('deepgram.mapResponse uses utterances and converts seconds → ms', () => {
  const resp = {
    results: {
      utterances: [
        { speaker: 0, start: 0, end: 2.5, transcript: 'Hello team.', confidence: 0.9 },
        { speaker: 1, start: 2.6, end: 4.0, transcript: 'Hey.', confidence: 0.8 },
      ],
    },
  };
  const lines = deepgram.mapResponse(resp);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { speakerTag: 1, startMs: 0, endMs: 2500, text: 'Hello team.', confidence: 0.9 });
  assert.equal(lines[1].speakerTag, 2);
  assert.equal(lines[1].startMs, 2600);
});

test('deepgram.mapResponse falls back to diarised words', () => {
  const resp = {
    results: {
      channels: [{
        alternatives: [{
          words: [
            { speaker: 0, start: 0, end: 0.4, punctuated_word: 'One', confidence: 0.9 },
            { speaker: 0, start: 0.4, end: 0.8, punctuated_word: 'two.', confidence: 0.9 },
            { speaker: 1, start: 1.0, end: 1.4, word: 'three', confidence: 0.9 },
          ],
        }],
      }],
    },
  };
  const lines = deepgram.mapResponse(resp);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, 'One two.');
  assert.equal(lines[0].endMs, 800);
  assert.equal(lines[1].speakerTag, 2);
});

test('deepgram.buildQuery always opts out of model training', () => {
  const q = deepgram.buildQuery({ languageCodes: ['en-US'], env: {} });
  assert.match(q, /mip_opt_out=true/);
  assert.match(q, /diarize=true/);
  assert.match(q, /language=en-US/);
  // multiple candidates → detect_language, not a forced language
  const q2 = deepgram.buildQuery({ languageCodes: ['en-US', 'en-AU'], env: {} });
  assert.match(q2, /detect_language=true/);
});

test('seam providerName defaults unknown values to google (fail-safe)', () => {
  assert.equal(seam.providerName({ STT_PROVIDER: 'assemblyai' }), 'assemblyai');
  assert.equal(seam.providerName({ STT_PROVIDER: 'DEEPGRAM' }), 'deepgram');
  assert.equal(seam.providerName({ STT_PROVIDER: 'whisper' }), 'google');
  assert.equal(seam.providerName({}), 'google');
});

test('seam getProvider returns null for google, handles for others', () => {
  assert.equal(seam.getProvider({ STT_PROVIDER: 'google' }), null);
  const aai = seam.getProvider({ STT_PROVIDER: 'assemblyai', ASSEMBLYAI_API_KEY: 'k' });
  assert.equal(aai.name, 'assemblyai');
  assert.equal(aai.mode, 'poll');
  const dg = seam.getProvider({ STT_PROVIDER: 'deepgram', DEEPGRAM_API_KEY: 'k' });
  assert.equal(dg.name, 'deepgram');
  assert.equal(dg.mode, 'inline');
});

test('seam operation-id encode/decode round-trips and routes by prefix', () => {
  const enc = seam.encodeOperationId('assemblyai', 'abc-123');
  assert.equal(enc, 'assemblyai:abc-123');
  assert.deepEqual(seam.decodeOperationId(enc), { provider: 'assemblyai', jobId: 'abc-123' });
  // Google LRO names (no known prefix) decode to provider:null → legacy path
  const g = seam.decodeOperationId('projects/x/locations/global/operations/999');
  assert.equal(g.provider, null);
});

test('assemblyai.languageParams: single code forced, many → auto-detect', () => {
  assert.deepEqual(assemblyai.languageParams(['en-US']), { language_code: 'en-US' });
  assert.deepEqual(assemblyai.languageParams(['en-US', 'en-AU']), { language_detection: true });
  assert.deepEqual(assemblyai.languageParams([]), { language_detection: true });
});
