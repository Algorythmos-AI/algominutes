import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// packages/ai/src/speaker-align.cjs: the notetaker's speaker names. Each STT
// word takes the speaker whose turn it falls in (docs/plans/MEETINGS.md).
const require = createRequire(import.meta.url);
const { alignWords, SKEW_MS, GAP_CARRY_MS } = require('../packages/ai/src/speaker-align.cjs');

const w = (startMs: number, endMs: number, text = 'x') => ({ startMs, endMs, text, confidence: 0.9 });
const tags = (words: Array<{ speakerTag: number }>) => words.map((x) => x.speakerTag);
const turns = [
  { startMs: 0, endMs: 4000, speakerTag: 1 },
  { startMs: 4000, endMs: 9000, speakerTag: 2 },
  { startMs: 12000, endMs: 15000, speakerTag: 1 },
];

describe('alignWords', () => {
  it('gives each word the speaker whose turn it is in', () => {
    expect(tags(alignWords([w(100, 500), w(3000, 3500), w(4500, 5000), w(12500, 13000)], turns))).toEqual([1, 1, 2, 1]);
  });

  it('a word spanning a hand-over goes to whoever spoke more of it', () => {
    expect(tags(alignWords([w(3800, 4600)], turns))).toEqual([2]);
    expect(tags(alignWords([w(3400, 4200)], turns))).toEqual([1]);
  });

  it('tolerates a small clock skew between the timeline and the audio', () => {
    // 100 ms after speaker 2's turn ends, with no word before it to carry from.
    expect(SKEW_MS).toBeGreaterThan(100);
    expect(tags(alignWords([w(9100, 9200)], turns))).toEqual([2]);
    // Far outside the skew: unknown.
    expect(tags(alignWords([w(9000 + SKEW_MS + 500, 9000 + SKEW_MS + 600)], turns))).toEqual([0]);
  });

  it('carries the speaker through a short silence, but never across a long one', () => {
    // 9000..12000 has no turn: a word at 9800 follows speaker 2's last word.
    expect(tags(alignWords([w(8500, 8900), w(9800, 10000)], turns))).toEqual([2, 2]);
    expect(tags(alignWords([w(8500, 8900), w(8900 + GAP_CARRY_MS + 600, 8900 + GAP_CARRY_MS + 700)], turns))).toEqual([2, 0]);
  });

  it('is unknown (0) where there is no timeline, rather than guessing', () => {
    expect(tags(alignWords([w(20000, 20500)], turns))).toEqual([0]);
    expect(tags(alignWords([w(100, 200)], []))).toEqual([0]);
    expect(tags(alignWords([w(100, 200)], undefined))).toEqual([0]);
  });

  it('keeps every word and its order, copies rather than modifies, and ignores bad segments', () => {
    const input = [w(4500, 5000, 'b'), w(100, 500, 'a')];
    const out = alignWords(input, [...turns, { startMs: Number.NaN, endMs: 1, speakerTag: 3 }, { startMs: 0, endMs: 99999, speakerTag: 0 }]);
    expect(out.map((x: any) => x.text)).toEqual(['b', 'a']);
    expect(tags(out)).toEqual([2, 1]);
    expect((input[0] as any).speakerTag).toBeUndefined();
    expect(out[0]).toMatchObject({ confidence: 0.9 });
  });

  it('handles point-like words and unsorted segments', () => {
    const shuffled = [turns[2], turns[0], turns[1]];
    expect(tags(alignWords([w(2000, 2000), w(6000, 6000)], shuffled))).toEqual([1, 2]);
  });

  it('stays linear on a long meeting (3 hours, a turn every 5 s)', () => {
    const segs = Array.from({ length: 2160 }, (_, i) => ({ startMs: i * 5000, endMs: i * 5000 + 5000, speakerTag: (i % 4) + 1 }));
    const words = Array.from({ length: 30000 }, (_, i) => w(i * 360, i * 360 + 300));
    const t = Date.now();
    const out = alignWords(words, segs);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(out.every((x: any) => x.speakerTag >= 1)).toBe(true);
  });
});
