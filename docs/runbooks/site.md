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
| `VITE_FIREBASE_AUTH_DOMAIN` | `staging.algominutes.algorythmos.com` (where `/__/auth` is proxied) |
| `VITE_FIREBASE_API_KEY` | **owner:** the "AlgoMinutes Web" app's key (Firebase → Project settings → Your apps) |
| `VITE_FIREBASE_VAPID_KEY` | **owner, optional:** Firebase → Project settings → Cloud Messaging → Web Push certificates → Generate key pair, then the **public** key. Without it the build has no push: no prompt, no Settings section |

Production gets none of these until the launch (plan Phase 3), so it keeps the "coming soon" page.

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
`.github/workflows/web-e2e.yml` runs it nightly, on demand, and after each successful staging deploy.

**Owner, once:** Vercel → algominutes-site → Settings → Deployment Protection → **Protection Bypass for
Automation** → create a secret, then add it to GitHub as the Actions secret `VERCEL_AUTOMATION_BYPASS_SECRET`.
Until then, the job warns and stops. The journey also needs the staging sign-in settings above, since the guest signs
in on the staging domain, and the api's `allowed_origins` apply (`terraform apply`).

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
