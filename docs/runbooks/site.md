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

## DNS (Cloudflare, zone `algorythmos.com`)

Two records, both **DNS only** (grey cloud), like the zone's other Vercel records. Vercel issues the certificates.

| Type | Name | Target |
|---|---|---|
| CNAME | `algominutes` | the value Vercel shows for the domain (`cname.vercel-dns.com` or a project-specific `*.vercel-dns-*.com`) |
| CNAME | `staging.algominutes` | the same |

Check: `dig +short algominutes.algorythmos.com CNAME` and `curl -sI https://algominutes.algorythmos.com/privacy`.

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
