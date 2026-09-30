import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

// Boot-time env validation (added in the Dockerfile PR). Tests use exit:false so
// a failure throws instead of calling process.exit, and a capturing logger so we
// can assert the structured event.
const require = createRequire(import.meta.url);
const { requireEnv } = require('@algominutes/ai/require-env.cjs') as typeof import('../packages/ai/src/require-env.cjs');

function capturingLogger() {
  const calls: Array<{ obj: unknown; msg: string }> = [];
  return { calls, error: (obj: unknown, msg: string) => calls.push({ obj, msg }) };
}
type RequireEnv = (s: object, spec: object, o: object) => string[];

const saved = { ...process.env };
beforeEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
});
afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe('requireEnv', () => {
  it('passes when all required vars are present', () => {
    process.env.A = 'x';
    process.env.B = 'y';
    const log = capturingLogger();
    expect(() =>
      requireEnv('svc', { required: ['A', 'B'] }, { logger: log, exit: false }),
    ).not.toThrow();
    expect(log.calls).toHaveLength(0);
  });

  it('throws and logs env_validation_failed listing every missing required var', () => {
    process.env.A = 'x';
    const log = capturingLogger();
    expect(() =>
      requireEnv('svc', { required: ['A', 'B', 'C'] }, { logger: log, exit: false }),
    ).toThrow(/env_validation_failed/);
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]!.msg).toBe('env_validation_failed');
    const problems = (log.calls[0]!.obj as { problems: string[] }).problems;
    expect(problems).toContain('missing required env B');
    expect(problems).toContain('missing required env C');
    expect(problems).not.toContain('missing required env A');
  });

  it('treats an empty / whitespace-only value as missing', () => {
    process.env.A = '   ';
    const log = capturingLogger();
    expect(() => requireEnv('svc', { required: ['A'] }, { logger: log, exit: false })).toThrow();
  });

  it('satisfies a oneOf group when any inner set is fully present', () => {
    process.env.PGHOST = 'h';
    process.env.PGDATABASE = 'd';
    process.env.PGUSER = 'u';
    process.env.PGPASSWORD = 'p';
    const log = capturingLogger();
    expect(() =>
      requireEnv(
        'svc',
        { oneOf: [{ label: 'a Postgres target', of: [['DATABASE_URL'], ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']] }] },
        { logger: log, exit: false },
      ),
    ).not.toThrow();
  });

  it('fails a oneOf group when no inner set is fully present', () => {
    process.env.PGHOST = 'h'; // partial — missing the rest
    const log = capturingLogger();
    expect(() =>
      requireEnv(
        'svc',
        { oneOf: [{ label: 'a Postgres target', of: [['DATABASE_URL'], ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']] }] },
        { logger: log, exit: false },
      ),
    ).toThrow(/Postgres target/);
  });

  it('exact: passes only when the value matches exactly', () => {
    process.env.WRITE_POSTGRES = 'true';
    const log = capturingLogger();
    expect(() => requireEnv('svc', { exact: { WRITE_POSTGRES: 'true' } }, { logger: log, exit: false })).not.toThrow();
  });

  it('exact: rejects an unset flag AND a wrong value, naming what it got', () => {
    const log = capturingLogger();
    expect(() => requireEnv('svc', { exact: { WRITE_POSTGRES: 'true' } }, { logger: log, exit: false })).toThrow(
      /WRITE_POSTGRES must be 'true' \(got unset\)/,
    );
    process.env.WRITE_POSTGRES = 'false';
    expect(() => requireEnv('svc', { exact: { WRITE_POSTGRES: 'true' } }, { logger: log, exit: false })).toThrow(
      /got 'false'/,
    );
  });

  // Config a later Terraform apply sets (RELEASE.md rev 11, H1a): a service boots without it, and says so,
  // so an image merged before its apply never crash-loops the deploy.
  it('soft: boots without a soft var, and returns the missing names without logging a failure', () => {
    process.env.A = 'x';
    const log = capturingLogger();
    const missing = (requireEnv as unknown as RequireEnv)('svc', { required: ['A'], soft: ['S1', 'S2'] }, { logger: log, exit: false });
    expect(missing).toEqual(['S1', 'S2']);
    expect(log.calls).toHaveLength(0);
  });

  it('soft: a blank soft var is missing; a set one is not', () => {
    process.env.S1 = '  ';
    process.env.S2 = 'y';
    const log = capturingLogger();
    expect((requireEnv as unknown as RequireEnv)('svc', { soft: ['S1', 'S2'] }, { logger: log, exit: false })).toEqual(['S1']);
  });

  it('soft: a missing required var still fails, and the soft ones are not listed as its problems', () => {
    const log = capturingLogger();
    expect(() => requireEnv('svc', { required: ['A'], soft: ['S1'] } as never, { logger: log, exit: false })).toThrow(/missing required env A/);
    expect((log.calls[0]!.obj as { problems: string[] }).problems).toEqual(['missing required env A']);
  });

  it('requires a logger', () => {
    expect(() => requireEnv('svc', { required: [] }, {} as never)).toThrow(/logger is required/);
  });
});

// checkEnv is the pure rule set requireEnv applies at boot; the Terraform
// contract test and scripts/check-tfplan-env.mjs call it on the env Terraform
// would give a service, so all three agree.
describe('checkEnv', () => {
  const { checkEnv } = require('@algominutes/ai/require-env.cjs');
  const spec = {
    required: ['A'],
    exact: { W: 'true' },
    oneOf: [{ label: 'a target', of: [['URL'], ['H', 'U']] }],
  };

  it('passes a complete env, reading only the env it is given', () => {
    expect(checkEnv(spec, { A: 'x', W: 'true', H: 'h', U: 'u' })).toEqual([]);
  });

  it('holds soft vars to the same rule as required ones: Terraform and a saved plan must set them', () => {
    expect(checkEnv({ soft: ['S'] }, {})).toEqual(['missing required env S']);
    expect(checkEnv({ soft: ['S'] }, { S: 'x' })).toEqual([]);
  });

  it('reports every problem: blank, wrong exact value, no oneOf group', () => {
    expect(checkEnv(spec, { A: '  ', W: 'false', H: 'h' })).toEqual([
      'missing required env A',
      'need a target: one of [URL OR H+U]',
      "env W must be 'true' (got 'false')",
    ]);
  });
});
