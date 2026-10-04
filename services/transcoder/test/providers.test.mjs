// Provider mapping tests. Run with `node --test` (Node 22 built-in runner) —
// no network, no keys, no DB. These pin the ONLY provider-specific logic that
// matters for correctness: mapping a vendor response to the neutral, global-tag
// line shape the rest of the pipeline consumes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const neutral = require('../src/providers/neutral.js');
const stt = require('../src/stt.js');
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

// N6: a monologue with no pause used to be one line of thousands of characters.
test('a line ends at 30 s or 1,000 characters, even with no pause or new speaker', () => {
  // 90 s of one speaker, a 12-character word every 300 ms, no gap over 1.5 s.
  const words = Array.from({ length: 300 }, (_, i) => ({
    speakerTag: 1, startMs: i * 300, endMs: i * 300 + 250, text: 'wordwordword', confidence: 0.9,
  }));
  for (const [name, toLines] of [['neutral', neutral.wordsToLines], ['stt', stt.wordsToLines]]) {
    const lines = toLines(words);
    assert.ok(lines.length >= 3, `${name}: ${lines.length} lines`);
    for (const l of lines) {
      assert.ok(l.endMs - l.startMs <= 30_000 + 300, `${name}: a line spans ${l.endMs - l.startMs} ms`);
      assert.ok(l.text.length <= 1000 + 13, `${name}: a line has ${l.text.length} characters`);
    }
    // Every word is kept, in order.
    assert.equal(lines.map((l) => l.text).join(' '), words.map((w) => w.text).join(' '));
  }
});

test('a line ends at 1,000 characters when speech is dense', () => {
  // Long words, fast: the character limit comes before the 30 s one.
  const words = Array.from({ length: 200 }, (_, i) => ({
    speakerTag: 2, startMs: i * 50, endMs: i * 50 + 40, text: 'x'.repeat(40), confidence: 0.9,
  }));
  for (const toLines of [neutral.wordsToLines, stt.wordsToLines]) {
    const lines = toLines(words);
    assert.ok(lines.length > 1);
    for (const l of lines) assert.ok(l.text.length <= 1000 + 41, `${l.text.length} characters`);
  }
});

// Found by the weekly 240-minute e2e (2026-10-03): 25,728 transcript lines for 4 hours. Speech-to-text without
// diarization gives words no speaker (flattenWords: null), and each one started a new line.
test('stt.wordsToLines keeps untagged words on one line: no speaker is one speaker', () => {
  const said = 'the quarterly budget was agreed and hiring opens in sydney next month'.split(' ');
  for (const tag of [null, undefined, 0]) {
    const words = said.map((text, i) => ({ text, startMs: i * 400, endMs: i * 400 + 350, confidence: 0.9, speakerTag: tag }));
    const lines = stt.wordsToLines(words);
    assert.equal(lines.length, 1, `speakerTag ${tag}: ${lines.length} lines`);
    assert.equal(lines[0].text, said.join(' '));
    assert.equal(lines[0].speakerTag, 0);
    assert.equal(lines[0].startMs, 0);
    assert.equal(lines[0].endMs, (said.length - 1) * 400 + 350);
  }
});

test('stt.wordsToLines still ends a line on a pause, and when a tagged speaker changes', () => {
  const w = (text, startMs, speakerTag) => ({ text, startMs, endMs: startMs + 300, confidence: 0.9, speakerTag });
  const paused = stt.wordsToLines([w('one', 0, null), w('two', 400, null), w('three', 4000, null)]);
  assert.deepEqual(paused.map((l) => l.text), ['one two', 'three']);
  const speakers = stt.wordsToLines([w('hello', 0, 1), w('there', 400, 1), w('hi', 800, 2)]);
  assert.deepEqual(speakers.map((l) => [l.speakerTag, l.text]), [[1, 'hello there'], [2, 'hi']]);
});

test('a 4-hour recording of untagged words is hundreds of lines, not tens of thousands', () => {
  // 150 words a minute, no pause over 1.5 s: the 30 s rule alone ends lines.
  const words = Array.from({ length: 240 * 150 }, (_, i) => ({ text: `w${i}`, startMs: i * 400, endMs: i * 400 + 350, confidence: 0.9, speakerTag: null }));
  const lines = stt.wordsToLines(words);
  assert.ok(lines.length >= 440 && lines.length <= 520, `${lines.length} lines`);
  assert.equal(lines.map((l) => l.text).join(' '), words.map((x) => x.text).join(' '));
});

// A number read out in groups stays on one line, so redaction (which scrubs a
// line at a time) still sees the whole of it.
test('a full line never ends between two groups of digits', () => {
  const card = ['4111', '1111', '1111', '1111'];
  // Filler so the line reaches 1,000 characters on the card's third group, then more speech.
  const filler = Array.from({ length: 82 }, (_, i) => `word${String(i).padStart(7, '0')}`);
  const texts = [...filler, 'card', ...card, 'thanks', 'everyone'];
  const words = texts.map((text, i) => ({ speakerTag: 1, startMs: i * 200, endMs: i * 200 + 150, text, confidence: 0.9 }));
  for (const toLines of [neutral.wordsToLines, stt.wordsToLines]) {
    const lines = toLines(words);
    assert.ok(lines.length >= 2, 'the cap still ends the line');
    assert.ok(lines.some((l) => l.text.includes('4111 1111 1111 1111')), lines.map((l) => l.text.slice(-40)).join(' | '));
  }
});

test('a run of numbers still ends at twice the limit', () => {
  const words = Array.from({ length: 800 }, (_, i) => ({ speakerTag: 1, startMs: i * 100, endMs: i * 100 + 80, text: '1234', confidence: 0.9 }));
  for (const toLines of [neutral.wordsToLines, stt.wordsToLines]) {
    for (const l of toLines(words)) assert.ok(l.text.length <= 2000 + 5, `${l.text.length} characters`);
  }
});
