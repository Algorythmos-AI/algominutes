import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseClock, normalizeChapters, repairTruncatedJson, salvageSummaryJson } = require('@algominutes/ai/summary-output.cjs');
const { redactSummaryOutput } = require('@algominutes/ai/redaction.cjs');

describe('parseClock', () => {
  it("reads the transcript's own marks", () => {
    expect(parseClock('12:34')).toBe(754_000);
    expect(parseClock('1:02:03')).toBe(3_723_000);
    expect(parseClock('[00:05]')).toBe(5_000);
    expect(parseClock('75:00')).toBe(4_500_000); // minutes past an hour, no hour field
  });
  it('refuses anything else', () => {
    for (const bad of ['', 'noon', '1:60:00', '12:61', '1h02', null, undefined, 12]) expect(parseClock(bad)).toBeNull();
  });
});

describe('normalizeChapters', () => {
  it('parses, sorts, keeps one per start, drops the invalid, and caps at 40', () => {
    const out = normalizeChapters([
      { start: '30:00', title: ' Budget ', summary: 'Q4 numbers.' },
      { start: '00:00', title: 'Intros' },
      { start: '30:00', title: 'Duplicate start' },
      { start: '2:00:00', title: 'Past the end' },
      { start: 'soon', title: 'Bad time' },
      { start: '10:00', title: '   ' },
      'not an object',
    ], { maxMs: 45 * 60_000 });
    expect(out).toEqual([
      { startMs: 0, title: 'Intros', summary: '' },
      { startMs: 1_800_000, title: 'Budget', summary: 'Q4 numbers.' },
    ]);
    const many = Array.from({ length: 60 }, (_, i) => ({ start: `${i}:00`, title: `C${i}` }));
    expect(normalizeChapters(many)).toHaveLength(40);
    expect(normalizeChapters(undefined)).toEqual([]);
  });
});

describe('repairTruncatedJson and salvageSummaryJson', () => {
  const full = { gist: 'We shipped.', actionItems: ['Tell sales'], keyDecisions: ['Ship Friday'], chapters: [{ start: '00:00', title: 'A' }, { start: '10:00', title: 'B' }] };
  const text = JSON.stringify(full);

  it('a complete answer is not partial', () => {
    expect(salvageSummaryJson(text)).toEqual({ result: { ...full }, partial: false });
  });

  it('an answer cut off inside the chapters keeps everything complete before the cut', () => {
    const cut = text.slice(0, text.indexOf('"B"') + 2); // mid-way through the second chapter
    const { result, partial } = salvageSummaryJson(cut);
    expect(partial).toBe(true);
    expect(result).toMatchObject({ gist: 'We shipped.', actionItems: ['Tell sales'], keyDecisions: ['Ship Friday'] });
    // The half-written chapter comes back without its title, and normalizing drops it.
    expect(normalizeChapters(result.chapters)).toEqual([{ startMs: 0, title: 'A', summary: '' }]);
  });

  it('an answer cut off mid-string is repaired at the last complete value', () => {
    expect(repairTruncatedJson('{"gist":"ok","actionItems":["one","tw')).toEqual({ gist: 'ok', actionItems: ['one'] });
  });

  it('nothing to show is still an error: no gist, or nothing complete', () => {
    expect(() => salvageSummaryJson('{"gist": "unfini')).toThrow(/INVALID_JSON/);
    expect(() => salvageSummaryJson('{"actionItems": ["a"], "chapters": []}')).toThrow(/unexpected schema/);
    expect(() => salvageSummaryJson('not json')).toThrow(/INVALID_JSON/);
    // The error never quotes the model's text (it reaches logs and the dead letter).
    expect(() => salvageSummaryJson('Sure, jane@example.com is the owner')).toThrow(/^INVALID_JSON: unparseable model output \(\d+ chars\)$/);
    expect(repairTruncatedJson('{"gist": "a"} trailing')).toEqual({ gist: 'a' });
    expect(repairTruncatedJson('{"gist": 1 2}')).toBeNull();
  });
});

describe('redactSummaryOutput and chapters', () => {
  it("scrubs each chapter's title and summary, keeping its start", () => {
    const { summary, counts } = redactSummaryOutput({
      gist: 'g', chapters: [{ startMs: 5, title: 'Mail jane@example.com', summary: 'Card 4111 1111 1111 1111 came up.' }],
    });
    expect(summary.chapters[0].startMs).toBe(5);
    expect(summary.chapters[0].title).not.toContain('jane@example.com');
    expect(summary.chapters[0].summary).not.toContain('4111 1111 1111 1111');
    expect(Object.values(counts).reduce((a: number, b: any) => a + b, 0)).toBeGreaterThanOrEqual(2);
  });
});
