import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// PII pre-scrub is a hard invariant (CLAUDE.md §1): transcript text must be
// redacted before it reaches Gemini or the embedder. These tests pin the
// behaviour of the single source of truth, @algominutes/ai/redaction.cjs.
const require = createRequire(import.meta.url);
const { redactPII, redactLines, redactTranscriptLines, redactSummaryOutput, luhnValid } = require(
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

// Key-shaped fixtures are assembled at runtime, so no literal PEM marker sits in
// the source for secret scanners to flag (the bodies are random, not keys).
const DASH = '-'.repeat(5);
const BEGIN = (type = '', suffix = '') => `${DASH}BEGIN ${type}PRIVATE KEY${suffix}${DASH}`;
const END = (type = '', suffix = '') => `${DASH}END ${type}PRIVATE KEY${suffix}${DASH}`;

// Private keys. The old single regex missed PKCS#8 (`BEGIN PRIVATE KEY`, the
// format of GCP service-account keys), encrypted PKCS#8 and PGP blocks, and it
// was quadratic (CodeQL js/polynomial-redos). It's now a linear scan.
describe('private keys', () => {
  const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\nk3lPq9ZxYt8vN2mR4sW1aB6cD0eF7gH8iJ9kL2mN5oP';
  const block = (type: string, suffix = '') =>
    `${BEGIN(type, suffix)}\n${body}\n${END(type, suffix)}`;

  it.each([
    ['PKCS#8', block('')],
    ['encrypted PKCS#8', block('ENCRYPTED ')],
    ['RSA', block('RSA ')],
    ['EC', block('EC ')],
    ['OpenSSH', block('OPENSSH ')],
    ['PGP', block('PGP ', ' BLOCK')],
    ['RSA with PEM headers', `${BEGIN('RSA ')}\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0A1B\n\n${body}\n${END('RSA ')}`],
  ])('redacts a %s key and keeps the text around it', (_name, key) => {
    const r = redactPII(`see ${key} thanks`);
    expect(r.text).toBe('see <<REDACTED:PRIVATE_KEY>> thanks');
    expect(r.counts).toEqual({ private_key: 1 });
  });

  it('redacts a truncated key (no END) up to the end of its base64, and keeps the prose after it', () => {
    const r = redactPII(`key: ${BEGIN()}\n${body}\nand then we moved on to the budget.`);
    expect(r.text).toBe('key: <<REDACTED:PRIVATE_KEY>>and then we moved on to the budget.');
    expect(r.text).not.toContain('MIIEvQ');
  });

  it("an END for a different key type doesn't close the block", () => {
    const r = redactPII(`${BEGIN('RSA ')}\n${body}\n${END('EC ')} tail`);
    expect(r.text).not.toContain('MIIEvQ');
    expect(r.counts.private_key).toBe(1);
  });

  it('counts several keys in one text', () => {
    const r = redactPII(`${block('')} and ${block('RSA ')}`);
    expect(r.text).toBe('<<REDACTED:PRIVATE_KEY>> and <<REDACTED:PRIVATE_KEY>>');
    expect(r.counts.private_key).toBe(2);
  });

  it('stays linear with many different key types (the END lookup is one pass, not one per BEGIN)', () => {
    let s = '';
    for (let i = 0; s.length < 1_000_000; i++) s += `${BEGIN(`T${i} `)} `;
    const t = performance.now();
    redactPII(s);
    expect(performance.now() - t).toBeLessThan(1000); // was ~7 s with a per-type cache
  });

  it('redacts a truncated PGP block with Charset/Hash headers, and a short padded last line', () => {
    const r = redactPII(`${BEGIN('PGP ', ' BLOCK')}\nCharset: UTF-8\nHash: SHA256\n\nlQOYBF8Ym1MBCADK3lPq9ZxYt8vN2mR4sW1aB6cD0eF7\nAbCdEf12==\n=XyZ1\nthat was the whole thing`);
    expect(r.text).toBe('<<REDACTED:PRIVATE_KEY>>that was the whole thing');
  });

  it('stays linear on adversarial input (a megabyte of BEGIN markers)', () => {
    const s = BEGIN().repeat(40_000); // ~1 MB
    const t = performance.now();
    redactPII(s);
    expect(performance.now() - t).toBeLessThan(1000); // was ~16 s before
  });
});

// A transcript is scrubbed line by line. A key pasted across lines must be
// redacted on every line, not only on its BEGIN line.
describe('redactLines (a key across lines)', () => {
  const b64a = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7';
  const b64b = 'k3lPq9ZxYt8vN2mR4sW1aB6cD0eF7gH8iJ9kL2mN5oP==';
  const TAG = '<<REDACTED:PRIVATE_KEY>>';

  it('carries the key through its END, then stops', () => {
    const r = redactLines([`here it is ${BEGIN()}`, b64a, b64b, `${END()} ok`, 'and then the budget']);
    expect(r.texts).toEqual([`here it is ${TAG}`, TAG, TAG, `${TAG} ok`, 'and then the budget']);
    expect(r.counts).toEqual({ private_key: 1 });
  });

  it('with no END, stops at the first line of prose', () => {
    const r = redactLines([BEGIN('RSA '), b64a, 'next we discussed hiring', b64b]);
    expect(r.texts).toEqual([TAG, TAG, 'next we discussed hiring', b64b]);
  });

  it('keeps line count and order, and other PII on continuation lines is still scrubbed', () => {
    const r = redactLines([BEGIN(), `${b64a} mail me at a@b.co`, 'fine']);
    expect(r.texts).toHaveLength(3);
    expect(r.texts[1]).toBe(`${TAG}mail me at <<REDACTED:EMAIL>>`);
    expect(r.texts[2]).toBe('fine');
  });

  it('redactTranscriptLines carries it too (what the transcoder stores)', () => {
    const { lines } = redactTranscriptLines([
      { speaker: 'A', text: BEGIN() }, { speaker: 'A', text: b64a }, { speaker: 'B', text: 'thanks' },
    ]);
    expect(lines.map((l: { text: string }) => l.text)).toEqual([TAG, TAG, 'thanks']);
    expect(lines[0].speaker).toBe('A');
  });
});
