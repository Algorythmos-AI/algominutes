import { describe, it, expect } from 'vitest';
// @ts-expect-error: a plain .mjs script, no types
import { ENVS, parseArgs, runChecks } from '../scripts/check-signin-chain.mjs';

// scripts/check-signin-chain.mjs audits the web sign-in chain with admin access.
// Here gcloud and the network are fakes shaped like the real answers, so each
// link can be shown passing and failing with the fix it names.
const cfg = ENVS.staging;

function world(over: { referrers?: string[]; domains?: string[]; appleKey?: boolean; acao?: string | null; handler?: number; ssoPost?: boolean } = {}) {
  const referrers = over.referrers ?? ['localhost', `https://${cfg.site}/*`, `https://${cfg.authDomain}/*`];
  const domains = over.domains ?? ['localhost', cfg.site, cfg.authDomain];
  const gcloud = (args: string[]) =>
    args[0] === 'auth'
      ? 'ya29.FAKE-ACCESS-TOKEN\n'
      : JSON.stringify([{ displayName: cfg.browserKeyName, restrictions: { browserKeyRestrictions: { allowedReferrers: referrers }, apiTargets: [{ service: 'identitytoolkit.googleapis.com' }, { service: 'securetoken.googleapis.com' }] } }]);
  const fetch = async (url: string, init: { method?: string } = {}) => {
    if (url.endsWith('/config')) return new Response(JSON.stringify({ authorizedDomains: domains }));
    if (url.endsWith('/apple.com')) return new Response(JSON.stringify({ enabled: true, clientId: 'com.algorythmos.algominutes.signin', appleSignInConfig: { codeFlowConfig: over.appleKey === false ? {} : { teamId: 'T', keyId: 'K', privateKey: '-----BEGIN PRIVATE KEY-----FAKE' } } }));
    if (url.endsWith('/google.com')) return new Response(JSON.stringify({ enabled: true }));
    if (init.method === 'OPTIONS') return new Response(null, { status: 204, headers: over.acao === null ? {} : { 'access-control-allow-origin': over.acao ?? `https://${cfg.site}` } });
    if (init.method === 'POST') return over.ssoPost ? new Response(null, { status: 302, headers: { location: 'https://vercel.com/sso-api?url=x' } }) : new Response('ok');
    return new Response('ok', { status: over.handler ?? 200 });
  };
  const lines: string[] = [];
  return { gcloud, fetch, write: (s: string) => lines.push(s), lines };
}

describe('the sign-in chain audit', () => {
  it('passes when every link is set, and prints nothing secret', async () => {
    const w = world();
    expect(await runChecks(cfg, w)).toBe(true);
    expect(w.lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
    // Neither the access token nor the Apple private key is ever printed.
    expect(w.lines.join('')).not.toContain('ya29.FAKE-ACCESS-TOKEN');
    expect(w.lines.join('')).not.toContain('BEGIN PRIVATE KEY');
  });

  it.each([
    ['a referrer missing from the Browser key', { referrers: [`https://${cfg.site}/*`] }, `Add https://${cfg.authDomain}/* to the key's website restrictions`],
    ['the site missing from the authorized domains', { domains: [cfg.authDomain] }, `Add ${cfg.site} in Firebase → Authentication`],
    ["the Apple provider unable to exchange Apple's code", { appleKey: false }, "team ID, key ID and private key"],
    ["the api's CORS refusing the site", { acao: null }, "allowed_origins (Terraform)"],
    ['the auth handler down', { handler: 404 }, 'Check the auth domain'],
  ])('fails on %s, and names the fix', async (_name, over, fix) => {
    const w = world(over);
    expect(await runChecks(cfg, w)).toBe(false);
    expect(w.lines.join('')).toContain(fix);
  });

  it("catches the host's login protection swallowing Apple's cross-site POST when sign-in runs on the site", async () => {
    const own = { ...cfg, authDomain: cfg.site };
    const w = world({ ssoPost: true, referrers: [`https://${cfg.site}/*`], domains: [cfg.site] });
    expect(await runChecks(own, w)).toBe(false);
    expect(w.lines.join('')).toMatch(/FAIL a cross-site POST to the handler isn't intercepted.*vercel\.com/);
    expect(await runChecks(own, world({ referrers: [`https://${cfg.site}/*`], domains: [cfg.site] }))).toBe(true);
  });

  it('knows its environments', () => {
    expect(parseArgs([])).toBe(ENVS.staging);
    expect(parseArgs(['--env', 'staging'])).toBe(ENVS.staging);
    expect(() => parseArgs(['--env=nope'])).toThrow(/unknown --env nope/);
  });

  it("knows the beta: staging's project, signing in on its own host (so Apple's cross-site POST is checked)", () => {
    const beta = parseArgs(['--env', 'beta']);
    expect(beta).toBe(ENVS.beta);
    expect(beta).toMatchObject({ project: 'algominutes-staging', site: 'beta.algominutes.algorythmos.com', api: ENVS.staging.api });
    expect(beta.authDomain).toBe(beta.site);
  });
});
