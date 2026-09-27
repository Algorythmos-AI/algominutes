#!/usr/bin/env node
// The web sign-in chain, audited from the server side (docs/runbooks/site.md,
// "Sign-in troubleshooting"). /app/diagnostics checks it from a user's browser;
// this checks the same links with admin access, for an environment:
//   1. the Browser API key's website restrictions include the site and the auth domain;
//   2. Firebase Auth's authorized domains include both;
//   3. the Apple provider is enabled with its Services ID, team, key and private key;
//   4. the Google provider is enabled;
//   5. the api's CORS accepts the site;
//   6. the auth handler and iframe answer on the auth domain;
//   7. when sign-in runs on the site itself (the /__/auth proxy), a cross-site POST
//      to the handler (Apple's form_post) isn't intercepted by the host's login
//      protection (the staging failure of 2026-09-27).
// Read-only. Needs gcloud signed in as an account with access to the project.
// Nothing secret is printed. Exit 1 when any check fails.
//
//   node scripts/check-signin-chain.mjs --env staging
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const ENVS = {
  staging: {
    project: 'algominutes-staging',
    site: 'staging.algominutes.algorythmos.com',
    authDomain: 'algominutes-staging.firebaseapp.com',
    browserKeyName: 'Browser key (auto created by Firebase)',
    api: 'https://api-627101926311.australia-southeast1.run.app',
    account: 'algorythmos.france@gmail.com',
  },
};

export function parseArgs(argv) {
  const out = { env: 'staging' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env') out.env = argv[++i];
    else if (a.startsWith('--env=')) out.env = a.slice(6);
  }
  const cfg = ENVS[out.env];
  if (!cfg) throw new Error(`check-signin-chain: unknown --env ${out.env} (known: ${Object.keys(ENVS).join(', ')})`);
  return cfg;
}

const referrerCovers = (referrers, host) => referrers.some((r) => r === `https://${host}/*` || r === `https://${host}/` || r === host);

export async function runChecks(cfg, { gcloud, fetch = globalThis.fetch, write = (s) => process.stdout.write(s) }) {
  const results = [];
  const check = (name, ok, detail, fix) => {
    results.push({ name, ok: Boolean(ok) });
    write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}\n`);
    if (!ok && fix) write(`     fix: ${fix}\n`);
  };
  const hosts = [...new Set([cfg.site, cfg.authDomain])];

  // 1. The Browser key.
  const keys = JSON.parse(gcloud(['services', 'api-keys', 'list', '--project', cfg.project, '--format=json']));
  const browser = keys.find((k) => k.displayName === cfg.browserKeyName);
  if (!browser) check('the Browser API key exists', false, `no key named "${cfg.browserKeyName}"`, 'Check the project, or the key name in ENVS.');
  else {
    const referrers = browser.restrictions?.browserKeyRestrictions?.allowedReferrers ?? [];
    for (const h of hosts) check(`the Browser key accepts ${h}`, referrerCovers(referrers, h), `${referrers.length} referrers`, `Add https://${h}/* to the key's website restrictions (Google Cloud → Credentials).`);
    const apis = (browser.restrictions?.apiTargets ?? []).map((t) => t.service);
    for (const s of ['identitytoolkit.googleapis.com', 'securetoken.googleapis.com']) {
      check(`the Browser key may call ${s}`, apis.length === 0 || apis.includes(s), apis.length ? `${apis.length} APIs allowed` : 'no API restriction', `Add ${s} to the key's API restrictions.`);
    }
  }

  // 2-4. Firebase Auth.
  const token = gcloud(['auth', 'print-access-token']).trim();
  const admin = (p) => fetch(`https://identitytoolkit.googleapis.com/admin/v2/projects/${cfg.project}/${p}`, { headers: { Authorization: `Bearer ${token}`, 'X-Goog-User-Project': cfg.project } }).then((r) => r.json());
  const config = await admin('config');
  const domains = config.authorizedDomains ?? [];
  for (const h of hosts) check(`${h} is an authorized domain`, domains.includes(h), `${domains.length} domains`, `Add ${h} in Firebase → Authentication → Settings → Authorized domains.`);
  const apple = await admin('defaultSupportedIdpConfigs/apple.com');
  const code = apple.appleSignInConfig?.codeFlowConfig ?? {};
  check('the Apple provider is enabled', apple.enabled === true, apple.clientId ? `Services ID ${apple.clientId}` : 'no Services ID', 'Enable Apple in Firebase → Authentication → Sign-in method.');
  check("the Apple provider can exchange Apple's code (team, key, private key)", Boolean(code.teamId && code.keyId && code.privateKey), code.keyId ? `team ${code.teamId}, key ${code.keyId}` : 'no code-flow key', 'Set the Apple provider’s team ID, key ID and private key (.p8) in Firebase.');
  const google = await admin('defaultSupportedIdpConfigs/google.com');
  check('the Google provider is enabled', google.enabled === true, '', 'Enable Google in Firebase → Authentication → Sign-in method.');

  // 5. The api's CORS.
  const origin = `https://${cfg.site}`;
  const pre = await fetch(`${cfg.api}/v1/entitlement`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization,x-algominutes-client' } });
  check(`the api accepts ${origin} (CORS)`, pre.headers.get('access-control-allow-origin') === origin, `preflight ${pre.status}`, `Add ${origin} to the api's allowed_origins (Terraform), apply, then redeploy.`);

  // 6. The auth handler and iframe.
  for (const p of ['handler', 'iframe']) {
    const r = await fetch(`https://${cfg.authDomain}/__/auth/${p}`, { redirect: 'manual' });
    check(`https://${cfg.authDomain}/__/auth/${p} answers`, r.status === 200, `HTTP ${r.status}`, 'Check the auth domain, and the /__/auth proxy when it is the site itself.');
  }

  // 7. A cross-site POST (Apple's form_post) reaches the handler, when it's behind the site's own host.
  if (cfg.authDomain === cfg.site) {
    const r = await fetch(`https://${cfg.site}/__/auth/handler`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'state=check' });
    const loc = r.headers.get('location') ?? '';
    check("a cross-site POST to the handler isn't intercepted (Apple's reply)", !(r.status >= 300 && r.status < 400 && /sso|login/i.test(loc)), `HTTP ${r.status}${loc ? ` → ${new URL(loc).host}` : ''}`, "The host's login protection intercepts it: sign in on Firebase's own domain here (VITE_FIREBASE_AUTH_DOMAIN), or lift the protection.");
  }

  return results.every((r) => r.ok);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cfg = parseArgs(process.argv.slice(2));
  const gcloud = (args) => execFileSync('gcloud', [...args, `--account=${cfg.account}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const ok = await runChecks(cfg, { gcloud });
  process.exit(ok ? 0 : 1);
}
