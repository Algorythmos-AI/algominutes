// N6 (RELEASE.md rev 11): a transcript line of thousands of characters (a monologue with no pause, stored
// before lines were capped at 1,000) became one oversized embedding chunk. Every chunk now stays within
// TARGET_CHARS, and no words are lost or reordered.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chunkTranscript, TARGET_CHARS } = require('@algominutes/ai/embeddings.cjs') as {
  chunkTranscript: (l: unknown[]) => Array<{ text: string; startMs: number; endMs: number }>;
  TARGET_CHARS: number;
};

const words = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `word${from + i}`).join(' ');

describe('embedding chunks never pass TARGET_CHARS', () => {
  it('cuts a 5,000-character line into chunks of at most TARGET_CHARS', () => {
    const long = words(700); // about 5,500 characters
    const chunks = chunkTranscript([
      { speakerTag: 1, startMs: 0, endMs: 1000, text: 'good morning' },
      { speakerTag: 2, startMs: 1000, endMs: 601_000, text: long },
      { speakerTag: 1, startMs: 601_000, endMs: 602_000, text: 'thanks' },
    ]);
    expect(long.length).toBeGreaterThan(5000);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(TARGET_CHARS);
    // Every word of the long line reaches some chunk, each piece labelled with its speaker.
    const all = chunks.map((c) => c.text).join('\n');
    for (const w of ['word0 ', 'word350 ', 'word699']) expect(all).toContain(w);
    expect(all).toContain('good morning');
    expect(all).toContain('thanks');
    expect(chunks.filter((c) => c.text.includes('Speaker 2: ')).length).toBeGreaterThan(1);
    // Times move forward through the line.
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].startMs).toBeGreaterThanOrEqual(chunks[i - 1].startMs);
    expect(chunks[chunks.length - 1].endMs).toBe(602_000);
  });

  it('cuts a line with no spaces too', () => {
    const chunks = chunkTranscript([{ speakerTag: 1, startMs: 0, endMs: 10_000, text: 'x'.repeat(4500) }]);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(TARGET_CHARS);
    expect(chunks.map((c) => c.text.replace(/^Speaker 1: /gm, '')).join('').replace(/\n/g, '')).toContain('x'.repeat(1500));
  });

  it("leaves ordinary lines as they were", () => {
    const lines = Array.from({ length: 50 }, (_, i) => ({ speakerTag: 1 + (i % 2), startMs: i * 5000, endMs: i * 5000 + 4000, text: words(20, i * 20) }));
    const chunks = chunkTranscript(lines);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(TARGET_CHARS);
    expect(chunks[0].text.startsWith('Speaker 1: word0 word1')).toBe(true);
  });
});
