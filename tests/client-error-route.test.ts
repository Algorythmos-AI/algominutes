import { describe, it, expect } from 'vitest';
// @ts-expect-error: plain ESM route module, no type declarations
import { clientErrorRoute } from '../services/api/src/routes/client-error.js';

// POST /v1/client-error is public and anonymous. Its fields are capped, and
// control characters are flattened before they reach the log, so a caller
// can't shape the log's layout (CodeQL js/log-injection).
describe('POST /v1/client-error', () => {
  it('logs capped fields with line breaks flattened and control characters removed, and answers 204', () => {
    const logged: any[] = [];
    const req = {
      body: { message: 'boom\r\nFAKE severity=INFO\u0007', stack: 'Error: x\n    at a (a.js:1)\n    at b (b.js:2)', url: 'u'.repeat(500), extra: 'ignored', kind: 42 },
      log: { error: (o: unknown, m: string) => logged.push({ o, m }) },
    };
    const out = { status: 0 };
    const res = { status(c: number) { out.status = c; return this; }, send() { return this; } };
    clientErrorRoute(req, res);
    expect(out.status).toBe(204);
    const { o, m } = logged[0];
    expect(m).toBe('web_client_crash');
    expect(o.message).toBe('boom | FAKE severity=INFO ');
    expect(o.stack).toBe('Error: x |     at a (a.js:1) |     at b (b.js:2)');
    expect(o.url).toHaveLength(200);
    expect(o.extra).toBeUndefined();
    expect(o.kind).toBeUndefined(); // non-strings are dropped, never logged raw
    for (const v of Object.values(o)) if (typeof v === 'string') expect(v).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it('logs a diagnostic report (a cancelled sign-in, a CSP violation, a refused wake lock) as a warning, and anything else as a crash', () => {
    const logged: Array<{ level: string; m: string; kind?: string }> = [];
    const log = {
      error: (o: { kind?: string }, m: string) => logged.push({ level: 'error', m, kind: o.kind }),
      warn: (o: { kind?: string }, m: string) => logged.push({ level: 'warn', m, kind: o.kind }),
    };
    const res = { status() { return this; }, send() { return this; } };
    for (const kind of ['auth.signInCancelled', 'csp.violation', 'record.wakeLock', 'record.wakeLockRelease', 'auth.signIn', 'window.onerror', 'csp.violationX']) {
      clientErrorRoute({ body: { kind, message: 'm' }, log }, res);
    }
    expect(logged).toEqual([
      { level: 'warn', m: 'web_client_diagnostic', kind: 'auth.signInCancelled' },
      { level: 'warn', m: 'web_client_diagnostic', kind: 'csp.violation' },
      // A refused wake lock isn't a crash: the recording carries on.
      { level: 'warn', m: 'web_client_diagnostic', kind: 'record.wakeLock' },
      { level: 'warn', m: 'web_client_diagnostic', kind: 'record.wakeLockRelease' },
      { level: 'error', m: 'web_client_crash', kind: 'auth.signIn' },
      { level: 'error', m: 'web_client_crash', kind: 'window.onerror' },
      { level: 'error', m: 'web_client_crash', kind: 'csp.violationX' },
    ]);
  });
});
