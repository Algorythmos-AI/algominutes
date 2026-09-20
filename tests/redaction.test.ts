import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// PII pre-scrub is a hard invariant (CLAUDE.md §1): transcript text must be
// redacted before it reaches Gemini or the embedder. These tests pin the
// behaviour of the single source of truth, @algominutes/ai/redaction.cjs.
const require = createRequire(import.meta.url);
const { redactPII, redactTranscriptLines, redactSummaryOutput, luhnValid } = require(
  '@algominutes/ai/redaction.cjs',
) as typeof import('../packages/ai/src/redaction.cjs');

describe('redactPII', () => {
  it('returns an empty result for non-string / empty input', () => {
    expect(redactPII('')).toEqual({ text: '', counts: {} });
    // @ts-expect-error exercising the runtime guard
    expect(redactPII(null)).toEqual({ text: '', counts: {} });
  });

  it('redacts a Luhn-valid card but leaves a Luhn-invalid number alone', () => {
    const good = redactPII('pay to 4242 4242 4242 4242 today');
    expect(good.text).toContain('<<REDACTED:CARD>>');
    expect(good.counts.card).toBe(1);

    const bad = redactPII('order 1234 5678 9012 3456');
    expect(bad.text).toContain('1234 5678 9012 3456');
    expect(bad.counts.card).toBeUndefined();
  });

  it('redacts emails, SSNs, and JWTs', () => {
    const r = redactPII('mail me at jane.doe@example.com, ssn 123-45-6789');
    expect(r.text).toContain('<<REDACTED:EMAIL>>');
    expect(r.text).toContain('<<REDACTED:SSN>>');
    expect(r.text).not.toContain('jane.doe@example.com');
    expect(r.text).not.toContain('123-45-6789');
  });

  it('redacts the password inside a connection URI but keeps the scheme', () => {
    const r = redactPII('DATABASE_URL=postgres://user:s3cr3tpass@db.host:5432/app');
    expect(r.text).toContain('postgres://<<REDACTED:CREDENTIALS>>@');
    expect(r.text).not.toContain('s3cr3tpass');
    expect(r.counts.uri_credentials).toBe(1);
  });

  it('redacts a variety of provider credentials', () => {
    // Each fake secret is assembled from fragments so the raw shape never
    // appears as a literal in source (keeps the secret scanner quiet) while
    // still reconstructing to a value the redaction regexes match at runtime.
    const secrets = [
      'AKIA' + 'ABCDEFGHIJKLMNOP', // AWS access key id
      'ghp_' + 'a'.repeat(36), // GitHub token
      'xoxb-' + '123456789012-abcdefghijkl', // Slack
      'sk_live_' + 'a'.repeat(24), // Stripe
    ];
    for (const s of secrets) {
      const r = redactPII(`the key is ${s} ok`);
      expect(r.text, s).not.toContain(s);
    }
  });

  it('classifies an AU Medicare number as MEDICARE, not PHONE', () => {
    const r = redactPII('medicare 2123 45670 1');
    expect(r.text).toContain('<<REDACTED:MEDICARE>>');
    expect(r.counts.medicare).toBe(1);
    expect(r.counts.phone).toBeUndefined();
  });

  it('redacts an AU mobile number as PHONE', () => {
    const r = redactPII('call me on 0412 345 678');
    expect(r.text).toContain('<<REDACTED:PHONE>>');
    expect(r.counts.phone).toBe(1);
  });

  it('leaves ordinary prose untouched', () => {
    const clean = 'The meeting covered roadmap priorities and next quarter hiring.';
    const r = redactPII(clean);
    expect(r.text).toBe(clean);
    expect(r.counts).toEqual({});
  });
});

describe('redactTranscriptLines', () => {
  it('scrubs each line and folds the per-line counts', () => {
    const { lines, counts } = redactTranscriptLines([
      { text: 'ping alice@corp.io', startMs: 0 },
      { text: 'no pii here', startMs: 1000 },
    ]);
    expect(lines[0]!.text).toContain('<<REDACTED:EMAIL>>');
    expect(lines[1]!.text).toBe('no pii here');
    expect(counts.email).toBe(1);
  });

  it('returns an empty result for a non-array input', () => {
    expect(redactTranscriptLines(undefined as never)).toEqual({ lines: [], counts: {} });
  });
});

describe('redactSummaryOutput', () => {
  it('scrubs gist and the string-list fields the model can emit', () => {
    const { summary, counts } = redactSummaryOutput({
      gist: 'Owner is bob@x.com',
      actionItems: ['email carol@y.com', 'ship the build'],
      keyDecisions: ['no pii'],
    });
    expect(summary.gist).toContain('<<REDACTED:EMAIL>>');
    expect(summary.actionItems[0]).toContain('<<REDACTED:EMAIL>>');
    expect(summary.actionItems[1]).toBe('ship the build');
    expect(counts.email).toBe(2);
  });
});

describe('luhnValid', () => {
  it('accepts a valid card and rejects an invalid one', () => {
    expect(luhnValid('4242424242424242')).toBe(true);
    expect(luhnValid('4242424242424241')).toBe(false);
  });
});
