# Runbook: the public site (algominutes.algorythmos.com)

`apps/site` is the public site: home, `/privacy`, `/terms`, `/support`, `/delete-account`, and
placeholders for the paths the api and billing link to (`/s/<token>`, `/billing/*`) and for the web
app (`/app`). It's static HTML with no JavaScript, hosted on Vercel, with DNS on Cloudflare.

## Where things are

| What | Where |
|---|---|
| Pages | `apps/site/src/pages/*.astro` |
| Who processes data, and where (the Privacy Policy's table) | `apps/site/src/data/processing.json`, checked by `tests/site-facts.test.ts` |
| Document versions | `TERMS_VERSION` / `PRIVACY_VERSION` in `packages/contracts/src/limits.ts`, mirrored in iOS `ComplianceContract.swift` |
| Headers, CSP, rewrites | `apps/site/vercel.json` |
| Vercel's handling of `vercel.json`, locally | `scripts/serve-site.mjs` (`node scripts/serve-site.mjs` serves `apps/site/dist` on :4322) |
| Deploy check | `scripts/smoke-site.mjs <origin>`, run by `.github/workflows/site-smoke.yml` |
| CI | the `site-build` job in `ci.yml` |
| Uptime | `google_monitoring_uptime_check_config.site` in `monitoring.tf` (staging's project until prod exists) |

## Environments

| Address | Git branch | Vercel environment | Who can open it |
|---|---|---|---|
| `algominutes.algorythmos.com` | `main` | Production | everyone |
| `staging.algominutes.algorythmos.com` | `integration` | Preview (branch domain) | Vercel team members (Vercel Authentication) |
| `<deployment>.vercel.app` | any PR branch | Preview | Vercel team members |

Site changes reach the public through the normal `integration → main` promotion PR. Vercel project
`algominutes-site` (team "skalaliya's projects", Pro): root directory `apps/site`, framework Astro,
install at the monorepo root (npm workspaces), production branch `main`.

## Change a page

1. Edit it in `apps/site/src/pages`, then `npm run build -w apps/site && npx vitest run --config vitest.site.config.ts`.
2. Look at it: `node scripts/serve-site.mjs`, then open http://localhost:4322.
3. **Privacy or Terms:** bump `TERMS_VERSION` / `PRIVACY_VERSION` (and the iOS mirror; `site-facts` checks
   it). Each client records a new acceptance on its next launch. **It doesn't ask the user yet**
   (BLOCKERS), so a significant change must also be announced, as the pages promise.
4. **A new processor, region or provider:** change `processing.json` in the same PR as the code.
   `site-facts` fails when the code and the policy disagree.

## The web app at /app (staging now, Production at the launch)

`scripts/build-site.mjs` builds the web app into the site only when `APP_ENABLED=true`. It refuses to build it
without every value below, or when `vercel.json` would block them: the api and billing origins must be in `/app`'s
`connect-src`, and a `/__/auth` rewrite must lead to the project's `firebaseapp.com`.

Vercel → algominutes-site → Settings → Environment Variables, **Preview**, each scoped to the **`integration`
branch** only (so PR previews keep the placeholder and never build the app):

| Variable | Staging value |
|---|---|
| `APP_ENABLED` | `true` |
| `VITE_API_ORIGIN` | `https://api-627101926311.australia-southeast1.run.app` |
| `VITE_BILLING_ORIGIN` | `https://billing-627101926311.australia-southeast1.run.app` |
| `VITE_FIREBASE_PROJECT_ID` | `algominutes-staging` |
| `VITE_FIREBASE_APP_ID` | `1:627101926311:web:3b656d832081e12b19ac82` ("AlgoMinutes Web") |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | `627101926311` |
| `VITE_FIREBASE_AUTH_DOMAIN` | `algominutes-staging.firebaseapp.com` (staging only; see **Sign-in on staging** below) |
| `VITE_FIREBASE_API_KEY` | **owner:** the "AlgoMinutes Web" app's key (Firebase → Project settings → Your apps) |
| `VITE_FIREBASE_VAPID_KEY` | **owner, optional:** Firebase → Project settings → Cloud Messaging → Web Push certificates → Generate key pair, then the **public** key. Without it the build has no push: no prompt, no Settings section |

Production gets none of these until the launch (plan Phase 3), so it keeps the "coming soon" page.

**Sign-in on staging runs on Firebase's own domain.** Staging is behind Vercel Authentication. Apple returns its
sign-in result as a cross-site POST (`form_post`) to the auth handler, and a cross-site POST carries no
`SameSite=Lax` cookie, so Vercel redirected it to its login and the credential was lost (`auth/invalid-credential-or-provider-id`;
a cookie-less POST to the staging `/__/auth/handler` gets a 302 to vercel.com/sso-api). So staging's
`VITE_FIREBASE_AUTH_DOMAIN` is `algominutes-staging.firebaseapp.com`. For that:
- `/app`'s CSP `frame-src` allows it (`scripts/build-site.mjs` refuses a build where it doesn't);
- the Browser key's website list has `https://algominutes-staging.firebaseapp.com/*` (and `…web.app/*`);
- Apple's Services ID and Google's OAuth client list its `/__/auth/handler`.

Production has no Vercel Authentication, so it signs in on its own origin, as below.

**Sign-in on the site's own origin.** `/__/auth/*` and `/__/firebase/*` on `staging.algominutes.algorythmos.com`
are proxied to `algominutes-staging.firebaseapp.com`, so the Firebase popup and iframe are same-origin. Those
paths keep Firebase's own headers: no site CSP, no `X-Frame-Options`, no COOP. `/app` sends
`Cross-Origin-Opener-Policy: same-origin-allow-popups` so the Google and Apple popups can report back.

**Owner, once, in the consoles** (security settings, so they're yours):

1. Firebase → Authentication → Settings → **Authorized domains**: add `staging.algominutes.algorythmos.com`
   (and `algominutes.algorythmos.com` at the launch).
2. Google Cloud → APIs & Services → Credentials → the **OAuth 2.0 Web client** Firebase created: add
   `https://staging.algominutes.algorythmos.com/__/auth/handler` to **Authorized redirect URIs** and
   `https://staging.algominutes.algorythmos.com` to **Authorized JavaScript origins**.
3. Apple Developer → Identifiers → Services ID `com.algorythmos.algominutes.signin` → Sign in with Apple →
   Configure: add the domain `staging.algominutes.algorythmos.com` and the return URL
   `https://staging.algominutes.algorythmos.com/__/auth/handler`.
4. Google Cloud → Credentials → the **Browser key**: set its website restrictions to
   `https://staging.algominutes.algorythmos.com/*` and `https://algominutes.algorythmos.com/*` (it allows
   `algominutes.com`, which we don't own, today). If the key also has **API restrictions**, web push needs
   **Firebase Cloud Messaging API**, **FCM Registration API** and **Firebase Installations API** on the list
   (all three are enabled on the project).

**Web push.** The app's service worker is `/app/sw.js` (scope `/app/`), built by `apps/web/vite.sw.config.ts` and
checked for by `scripts/build-site.mjs`. It caches nothing. It shows the notifier's notifications itself: when one of
the app's own windows is in view it sends that window a notice instead (public-site pages don't count, unlike in
Firebase's worker). A tap asks the app's window in front to open `notes/<id>` through its router (so a recording
page's "You're recording" guard applies), or opens a new window at the worker's scope, so staging opens staging
whatever deep link the notifier sent (iOS's `algominutes://note/<id>`). The browser is only asked after a click, on a
card shown once the user has a note, or from Settings; sign-out deletes the browser's FCM token first. To check: turn
notifications on, upload a short file, switch to another tab, and wait for "ready"; tapping it opens the note.

## Sign-in troubleshooting (staging and production)

Sign-in crosses five systems, and a missing setting in any of them can fail silently. So the web app traces every
attempt, and anyone can run a self-test from their own browser.

**1. Ask for the sign-in check.** `https://<site>/app/diagnostics` is public, and it's linked from the sign-in error
("Run a sign-in check"). From that browser it checks:
- the page's CSP (`script-src`, `connect-src`, and `frame-src` when sign-in runs on another domain);
- that the Browser API key accepts the site, and that the site and auth domain are Firebase authorized domains
  (one real request);
- that the sign-in handler answers (our `/__/auth` proxy, or Firebase's domain in a frame);
- the api's CORS;
- whether popups are allowed;
- the last attempt's trace.

Every failing check names its fix. **Copy report** gives one paste with the API key masked and no personal details.

**2. Read the traces in the api's logs.** Every failed or unfinished attempt is reported through `/v1/client-error`:

| Log event (`jsonPayload.msg`) | `kind` | Severity | Means |
|---|---|---|---|
| `web_client_crash` | `auth.signIn` | ERROR | Firebase refused the attempt; the message holds its code and the trace |
| `web_client_diagnostic` | `auth.signInCancelled` | WARNING | the window closed without a result: by hand, or a blocked relay |
| `web_client_diagnostic` | `csp.violation` | WARNING | the page's CSP refused an origin (`<directive> <origin>`, never a full URL) |

A trace (the message's JSON) holds:
- `id` (the attempt), `p` (provider), `f` (sign-in or guest link);
- `d` (auth domain), `h` (page host);
- `o` (outcome), `c` (Firebase's code);
- `s` (timed steps, in ms);
- `csp` (violations during the attempt).

```bash
gcloud logging read 'resource.labels.service_name="api" AND jsonPayload.kind:"auth." AND timestamp>="2026-09-27T00:00:00Z"' --project algominutes-staging --account algorythmos.france@gmail.com --limit 20 --format="value(timestamp,jsonPayload.kind,jsonPayload.message)"
```

```bash
gcloud logging read 'resource.labels.service_name="api" AND jsonPayload.kind="csp.violation"' --project algominutes-staging --account algorythmos.france@gmail.com --limit 20 --format="value(timestamp,jsonPayload.message,jsonPayload.url)"
```

`kind` is set by the (anonymous) client, so a caller could label a crash as a diagnostic. It's still logged, with its
`traceId`, just at WARNING. Don't build a security decision on it.

**3. The chain, and what each failure means:**

| Link | Check | Symptom when it breaks | Fix |
|---|---|---|---|
| Page CSP | the sign-in check; `csp.violation` | "Framing … violates frame-src", "Refused to connect" | add the origin to `/app`'s CSP (`apps/site/vercel.json`); `scripts/build-site.mjs` refuses an auth domain the CSP can't frame |
| Browser API key | the sign-in check ("key") | 403 `API_KEY_HTTP_REFERRER_BLOCKED` | add `https://<site>/*` (and `https://<authDomain>/*`) to the key's website restrictions |
| Firebase authorized domains | the sign-in check ("domain") | `auth/unauthorized-domain`, "This site isn't authorised for sign-in" | Firebase → Authentication → Settings → Authorized domains |
| Apple Services ID | Apple's page shows `invalid_request` / `invalid_client` | the Apple window errors | add the domain and `https://<authDomain>/__/auth/handler` return URL |
| Apple code exchange | `auth.signIn` with `auth/invalid-credential…` | "Apple sign-in didn't complete" | the Apple provider's key (YMZ3K33U6D, team NY9MS8GSBK) and its `.p8` in Firebase |
| Google OAuth client | Google's page shows `redirect_uri_mismatch` | the Google window errors | add the origin and `…/__/auth/handler` redirect URI |
| Relay back to the page | `auth.signInCancelled` right after the user approved | the window closes, nothing happens | frame-src, or third-party storage for the auth domain; staging signs in on Firebase's domain (see above) |
| api CORS | the sign-in check ("api") | signed in, then every call fails | `allowed_origins` (Terraform), then apply, then redeploy the services |

**4. Staging only:** it's behind Vercel Authentication, so incognito, or anyone outside the Vercel team, gets
Vercel's login; that's by design. After a header change, use a freshly loaded tab: a tab loaded earlier keeps the old
policy.

## DNS (Cloudflare, zone `algorythmos.com`)

Two records, both **DNS only** (grey cloud), like the zone's other Vercel records. Vercel issues the certificates.

| Type | Name | Target |
|---|---|---|
| CNAME | `algominutes` | the value Vercel shows for the domain (`cname.vercel-dns.com` or a project-specific `*.vercel-dns-*.com`) |
| CNAME | `staging.algominutes` | the same |

Check: `dig +short algominutes.algorythmos.com CNAME` and `curl -sI https://algominutes.algorythmos.com/privacy`.

## The web app, end to end (`web-e2e`)

`scripts/e2e-web.mjs` walks one guest's life on staging in headless Chromium:
- sign in as a guest;
- import `tests/fixtures/e2e-speech.ogg` (ten seconds of synthetic speech), and it gets a summary;
- search, then ask a question;
- record in the browser, with a fake microphone playing the same speech;
- delete the account.

The deletion runs even after a failed step. Any console or page error fails the run, including a CSP refusal.
`.github/workflows/web-e2e.yml` runs it nightly, on demand, and once integration's head is fully deployed. Its gate
job (`scripts/e2e-web-gate.mjs`) wakes when deploy-staging finishes or Vercel deploys, and runs the journey only if:
- Vercel's deployment of integration's head succeeded;
- no deploy-staging run is queued or running;
- head's own deploy-staging run, if it has one, succeeded; if head changed no backend path, integration's last
  finished deploy-staging run succeeded.

The last deploy to finish starts the run. If both finish within about a minute of each other, it can run twice
in a row, which is harmless: one extra guest, created and deleted. The gate's log line says why it ran or skipped. Vercel reports each branch,
PR previews included, as a "Preview" deployment keyed by commit, so a deployment whose commit isn't integration's
head is skipped. The journey has a 20-minute budget (`E2E_BUDGET_MS`), and the account deletion always runs after
it. Each FAIL line says why its wait gave up.

**Owner, once:** Vercel → algominutes-site → Settings → Deployment Protection → **Protection Bypass for
Automation** → create a secret, then add it to GitHub as the Actions secret `VERCEL_AUTOMATION_BYPASS_SECRET`.
Until then, the job warns and stops. The staging sign-in settings and the api's `allowed_origins` are already in
place (2026-09-27).

To run it by hand:

```bash
VERCEL_BYPASS=… node scripts/e2e-web.mjs
```

It needs Playwright's Chromium (`npx playwright install chromium`) and ffmpeg.

## Check a deploy

```bash
node scripts/smoke-site.mjs https://algominutes.algorythmos.com
```

It checks every page answers 200 with its content and exactly the headers `vercel.json` gives that path. It
also checks the 404, the `.html` and `http://` redirects, and that `security.txt` has more than 30 days left.
For staging, export the project's automation bypass secret as `VERCEL_AUTOMATION_BYPASS_SECRET` first.
Add the same secret to the repository's Actions secrets to smoke preview deploys too; without it they're
skipped.

**The sign-in chain, with admin access** (read-only; gcloud signed in as `algorythmos.france@gmail.com`):

```bash
node scripts/check-signin-chain.mjs --env staging
```

It checks, printing each failing link with its fix and exiting 1:
- the Browser key's referrers and APIs;
- Firebase's authorized domains;
- the Apple provider (Services ID, team, key, private key) and the Google provider;
- the api's CORS;
- the auth handler and iframe;
- when sign-in runs on the site itself, that a cross-site POST (Apple's reply) isn't swallowed by the host's login
  protection.

Nothing secret is printed. Add a `prod` entry to its `ENVS` at the launch.

## Roll back

| Broken | Fix | Time |
|---|---|---|
| A bad deploy | Vercel → algominutes-site → Deployments → the previous Production deployment → **Instant Rollback** | seconds |
| A bad change on `main` | revert the PR on `integration`, then promote | one CI run |
| The domain itself | delete the Cloudflare CNAME (the site stops resolving; nothing else changes) | minutes |

Nothing on the site holds data, so a rollback never needs a data fix.

## Alerts

- **"algominutes site down"** (Cloud Monitoring): a public page failed from more than one region for
  10 minutes. Open the latest Production deployment in Vercel. If it's the cause, roll back. If it isn't,
  check the CNAME and Vercel's status page.
- **site-smoke failed** (GitHub Actions, after a deploy or daily): the failure lines name the path and the
  header or status. A `security.txt` expiry failure is fixed by any deploy, which renews it for 180 days.
