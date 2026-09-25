import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// db-job vertex-smoke: each ladder rung must also take the transcoder fast
// path's call (inline audio + its schema) before a deploy rolls out.
const require = createRequire(import.meta.url);
const { syntheticWav, smokeAudio } = require('../services/db-job/src/handlers/vertex-smoke.js');
const noop = () => {};
const log = { info: noop, warn: noop, error: noop };

describe('vertex-smoke audio check', () => {
  it('builds a valid 16 kHz mono PCM WAV', () => {
    const wav: Buffer = syntheticWav({ seconds: 2 });
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(40)).toBe(2 * 16000 * 2);
    expect(wav.length).toBe(44 + 2 * 16000 * 2);
  });

  it("sends the fast path's call shape to one rung, and passes on a schema-shaped STOP", async () => {
    const calls: any[] = [];
    const call = async (args: any) => {
      calls.push(args);
      return { rawText: JSON.stringify({ gist: '', actionItems: [], keyDecisions: [], transcript: [] }), finishReason: 'STOP' };
    };
    await smokeAudio({ model: 'gemini-3.5-flash', location: 'australia-southeast1', log, call });
    expect(calls[0].modelLadder).toEqual(['gemini-3.5-flash']);
    expect(calls[0].parts[0].inlineData.mimeType).toBe('audio/wav');
    expect(calls[0].generationConfig).toMatchObject({ responseMimeType: 'application/json', maxOutputTokens: 16384 });
    expect(calls[0].generationConfig.responseSchema.required).toContain('transcript');
    expect(calls[0].location).toBe('australia-southeast1');
  });

  it.each([
    ['an error', { error: new Error('400 audio not supported') }],
    ['a truncation', { rawText: '{"transcript": [', finishReason: 'MAX_TOKENS' }],
    ['an off-schema answer', { rawText: '{"gist": "x"}', finishReason: 'STOP' }],
  ])('fails the deploy on %s', async (_what, answer) => {
    await expect(smokeAudio({ model: 'm', location: 'l', log, call: async () => answer })).rejects.toThrow(/\(audio\)/);
  });
});
