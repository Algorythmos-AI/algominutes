import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { apiCheck, cspChecks, handlerCheck, maskKey, popupCheck, projectChecks, type DiagConfig } from './checks';
import { blockedOrigin, forgetLastTrace, lastTrace, recordViolation, resetViolations, startTrace, traceMessage } from './signInTrace';
import { installGlobalCrashHandlers } from '../crashReport';

afterEach(() => {
  resetViolations();
  forgetLastTrace();
});

const STAGING: DiagConfig = {
  host: 'staging.algominutes.algorythmos.com',
  authDomain: 'algominutes-staging.firebaseapp.com',
  projectId: 'algominutes-staging',
  apiKey: 'AIzaFAKEFAKEFAKEFAKE1234',
  apiOrigin: 'https://api-627101926311.australia-southeast1.run.app',
};
// The CSP /app is really served with (apps/site/vercel.json).
const vercel = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../../../site/vercel.json'), 'utf8'));
const APP_CSP: string = vercel.headers.find((r: { source: string }) => r.source === '/app(/.*)?').headers.find((h: { key: string }) => h.key === 'Content-Security-Policy').value;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('a sign-in trace', () => {
  it('keeps a blocked URI to its origin: never a path or query, which could carry a token', () => {
    expect(blockedOrigin('https://algominutes-staging.firebaseapp.com/__/auth/iframe?apiKey=SECRET&v=1')).toBe('https://algominutes-staging.firebaseapp.com');
    expect(blockedOrigin('inline')).toBe('inline');
    expect(blockedOrigin('eval')).toBe('eval');
    expect(blockedOrigin('data:text/html,hello')).toBe('data');
    expect(blockedOrigin('')).toBe('unknown');
  });

  it('records the steps, the outcome, the code and the CSP violations of its own attempt, and keeps the last one', () => {
    let now = 1000;
    recordViolation('frame-src', 'https://old.example/x', 500); // before the attempt: not part of it
    const t = startTrace('apple', 'signIn', STAGING.authDomain, () => now, STAGING.host);
    now = 1400;
    recordViolation('frame-src', 'https://algominutes-staging.firebaseapp.com/__/auth/iframe?x=1', now);
    now = 4000;
    const done = t.finish('error', 'auth/invalid-credential');
    expect(done).toMatchObject({ provider: 'apple', outcome: 'error', code: 'auth/invalid-credential', csp: ['frame-src https://algominutes-staging.firebaseapp.com'] });
    expect(done.steps).toEqual([['start', 0], ['error', 3000]]);
    expect(lastTrace()?.id).toBe(done.id);
    // Kept in memory only, never in the browser's storage.
    expect(sessionStorage.length + localStorage.length).toBe(0);
  });

  it('fits the crash report (500 characters), however many violations', () => {
    const t = startTrace('google', 'signIn', STAGING.authDomain, () => Date.now(), STAGING.host);
    for (let i = 0; i < 20; i++) recordViolation('connect-src', `https://host${i}.example.com/path`);
    const msg = traceMessage(t.finish('cancelled'));
    expect(msg.length).toBeLessThanOrEqual(480);
    expect(msg).toContain('"o":"cancelled"');
    expect(msg).not.toMatch(/\/path/);
  });

  it("the app's CSP listener records a violation for the trace", () => {
    installGlobalCrashHandlers();
    const e = Object.assign(new Event('securitypolicyviolation'), { effectiveDirective: 'frame-src', violatedDirective: 'frame-src', blockedURI: 'https://x.example/y?t=1', disposition: 'enforce' });
    const t = startTrace('apple', 'signIn', '', () => 0, '');
    document.dispatchEvent(e);
    expect(t.finish('cancelled').csp).toEqual(['frame-src https://x.example']);
  });
});

describe('the sign-in check', () => {
  it("passes /app's real CSP for staging, frame-src for Firebase's domain included", () => {
    expect(cspChecks(APP_CSP, STAGING).filter((c) => c.status !== 'ok')).toEqual([]);
  });

  it('names the missing origin and where to add it', () => {
    const noFrame = APP_CSP.replace(/frame-src [^;]*/, "frame-src 'self'");
    const [bad] = cspChecks(noFrame, STAGING).filter((c) => c.status === 'fail');
    expect(bad.fix).toBe("Add https://algominutes-staging.firebaseapp.com to /app's frame-src in apps/site/vercel.json.");
    // Signing in on our own domain needs no frame-src entry.
    expect(cspChecks(noFrame, { ...STAGING, authDomain: STAGING.host }).filter((c) => c.status === 'fail')).toEqual([]);
  });

  it('proves the API key accepts this site, and checks both domains are authorized', async () => {
    const ok = await projectChecks(STAGING, (async () => json({ authorizedDomains: ['localhost', 'staging.algominutes.algorythmos.com', 'algominutes-staging.firebaseapp.com'] })) as typeof fetch);
    expect(ok.map((c) => c.status)).toEqual(['ok', 'ok', 'ok']);
    expect(ok[0].detail).toContain('AIza…1234');
    expect(ok[0].detail).not.toContain(STAGING.apiKey);

    const missing = await projectChecks(STAGING, (async () => json({ authorizedDomains: ['algominutes-staging.firebaseapp.com'] })) as typeof fetch);
    expect(missing.find((c) => c.status === 'fail')?.fix).toBe('Add staging.algominutes.algorythmos.com in Firebase → Authentication → Settings → Authorized domains.');
  });

  it('turns a refused key into the exact referrers to add', async () => {
    const refused = await projectChecks(STAGING, (async () => json({ error: { code: 403, message: 'Requests from referer are blocked.', details: [{ reason: 'API_KEY_HTTP_REFERRER_BLOCKED' }] } }, 403)) as typeof fetch);
    expect(refused[0]).toMatchObject({ status: 'fail', detail: 'Firebase refused the key (API_KEY_HTTP_REFERRER_BLOCKED).' });
    expect(refused[0].fix).toContain('https://staging.algominutes.algorythmos.com/* and https://algominutes-staging.firebaseapp.com/*');
  });

  it("loads Firebase's handler in a frame when sign-in runs there, and fetches our proxy when it runs here", async () => {
    expect((await handlerCheck(STAGING, undefined, async () => true)).status).toBe('ok');
    expect((await handlerCheck(STAGING, undefined, async () => false)).fix).toContain('frame-src');
    const own = { ...STAGING, authDomain: STAGING.host };
    expect((await handlerCheck(own, (async () => new Response('', { status: 200 })) as typeof fetch)).status).toBe('ok');
    expect((await handlerCheck(own, (async () => new Response('', { status: 404 })) as typeof fetch)).fix).toContain('/__/auth');
  });

  it("reads the api's CORS answer: unreadable means this origin isn't allowed", async () => {
    expect((await apiCheck(STAGING, 'https://staging.algominutes.algorythmos.com', (async () => json({ ok: true })) as typeof fetch)).status).toBe('ok');
    const cors = await apiCheck(STAGING, 'https://staging.algominutes.algorythmos.com', (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch);
    expect(cors).toMatchObject({ status: 'fail' });
    expect(cors.fix).toBe("Add https://staging.algominutes.algorythmos.com to the api's allowed_origins (Terraform) and apply.");
  });

  it('knows when popups are blocked, and never shows the whole key', () => {
    const close = vi.fn();
    expect(popupCheck((() => ({ close })) as unknown as typeof window.open).status).toBe('ok');
    expect(close).toHaveBeenCalled();
    expect(popupCheck((() => null) as unknown as typeof window.open).status).toBe('warn');
    expect(maskKey('AIzaFAKE-TEST-KEY-9876')).toBe('AIza…9876');
    expect(maskKey('')).toBe('(not set)');
  });
});
