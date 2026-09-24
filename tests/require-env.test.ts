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

  it('requires a logger', () => {
    expect(() => requireEnv('svc', { required: [] }, {} as never)).toThrow(/logger is required/);
  });
});
