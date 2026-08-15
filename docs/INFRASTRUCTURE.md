# AlgoMinutes — Infrastructure & Accounts Registry

**Purpose.** A single place recording *what exists, where it lives, and who owns it*, so a future
session — human or agent — can orient without guesswork.

> ## ⚠️ NO SECRETS IN THIS FILE
> Never add a password, API key, private key, keystore password, service-account JSON, or OAuth
> secret here. This file is committed to git.
> - **Human credentials** → password manager
> - **Runtime secrets** → Google Secret Manager (BUILD-PLAN §4.2)
> - **CI secrets** → GitHub Actions repository secrets
> - **Signing keystore** → offline encrypted backup + Play App Signing
>
> To note that something exists, write "created — stored in Secret Manager as `<secret-name>`".
> Never the value.

**Last updated:** 15 August 2026
**Maintainer:** Sam Kalaliya

---

## 1. Legal entity

| Field | Value |
|---|---|
| Company | **Algorythmos Pty Ltd** |
| ACN | 701 006 626 |
| ABN | 22 701 006 626 |
| Type | Australian Proprietary Company, Limited by Shares |
| Status | Registered — ABN active from 3 Aug 2026, GST registered same date |
| Registered office & principal place of business | 1/457–459 Elizabeth Street, Surry Hills NSW 2010 (Bustle Studios) |
| Shareholding | 50/50 — Sam Kalaliya / Abhishek Yadav |

**Do not confuse with:** ABN 70 153 527 339 — Sam's **sole trader** ABN (KALALIYA, SAMEER RAJ), a
separate entity. All AlgoMinutes assets, contracts and billing belong to the **Pty Ltd**.

---

## 2. Product identifiers — canonical, do not deviate

| Context | Value |
|---|---|
| Wordmark (all user-facing text) | **AlgoMinutes** |
| iOS bundle ID | `com.algorythmos.algominutes` |
| iOS broadcast extension | `com.algorythmos.algominutes.BroadcastExtension` |
| iOS broadcast setup UI | `com.algorythmos.algominutes.BroadcastExtensionSetupUI` |
| **App Group** ⚠️ | `group.com.algorythmos.algominutes` |
| Android applicationId / package | `com.algorythmos.algominutes` |
| Android package path | `com/algorythmos/algominutes/` |
| Web domain | `algominutes.com` |
| API domain | `api.algominutes.com` |
| GCP region (all services, both envs) | `australia-southeast1` (Sydney) |

**Casing rule:** `AlgoMinutes` in prose and display names. **lowercase** in every identifier —
bundle IDs, package paths, npm names, repo names, service names, buckets, queues.
`Algominutes` or `algoMinutes` anywhere user-visible is a bug.

⚠️ **The App Group must never change after provisioning.** It carries the ReplayKit broadcast
extension → app audio handoff. Retrofitting it breaks recording capture *silently* — no error, no
audio.

---

## 3. Source control

| Item | Value |
|---|---|
| GitHub organisation | `Algorythmos-AI` |
| Repository | `github.com/Algorythmos-AI/algominutes` — **private** |
| Remote | `https://github.com/Algorythmos-AI/algominutes.git` |
| Default branch | `main` |
| Local working copy | `~/algominutes` |

### Upstream source repo — READ ONLY

| Item | Value |
|---|---|
| Repo | `skalaliya/wasssup-meeting` |
| Local clone | `~/src/wasssup-meeting` (full clone, 235 commits) |
| Push status | **Disabled** — `git remote set-url --push origin no_push` |

`algominutes` was created with **no shared git history**. Never commit or push to the source repo.

**Other local clones — do NOT use for build work:** `~/wasssup-meeting` (duplicate) ·
`~/Documents/wasssup-meeting-main` (stale, 72 commits on `fix/ci-functions-params` — safe to delete).

---

## 4. Google Cloud — ✅ provisioned 15 Aug 2026

### 4.1 Identity & organisation

| Item | Value |
|---|---|
| **Organisation** | `algorythmos.com` — **org ID `327264144426`** |
| Created via | **Cloud Identity Free** (SKU `identitybasic`) — free tier, up to 50 users |
| Org admin account | `gcp-admin@algorythmos.com` |
| Secondary owner | `algorythmos.france@gmail.com` |
| Domain verification | TXT record on `algorythmos.com` — `google-site-verification=4k5baR-…` (Cloudflare) |

**Cloud Identity provides identity only — no mailbox.** `gcp-admin@algorythmos.com` is a sign-in
identity; mail addressed to it lands in **Zoho** (§6). MX records were never touched.

**Account roles after setup:**

| Account | Role |
|---|---|
| `gcp-admin@algorythmos.com` | Organisation Admin · Owner on both projects · Billing Account Administrator. **Primary working account** |
| `algorythmos.france@gmail.com` | Owner on both projects · Billing Account Administrator · owns the payments profile. **Recovery only** |

⚠️ **Access risk:** the org admin is a single account. Ensure 2FA (authenticator or hardware key,
**not SMS**), a recovery email that will still exist in three years, and printed backup codes.

### 4.2 Billing

| Item | Value |
|---|---|
| Billing account name | Algorythmos Pty Ltd |
| Billing account ID | `01FDC8-CD8E58-F91D06` |
| Payments profile ID | `4856-9316-5477` |
| Profile type | **Organization** (permanent — cannot be switched to Individual) |
| Legal name on profile | Algorythmos Pty Ltd |
| Country | Australia |
| ABN on profile | 22 701 006 626 — ⚠️ **verify captured**; add under Billing → Payment settings if missing |
| Account status | Full account activated (not trial-limited) |
| Organisation | ⚠️ Still outside the org — "Change organization" unavailable at setup. Cosmetic; retry later |

**Free trial credit:** A$431.69, **expires 14 November 2026**. Shared across *both* projects — it is
per billing account, not per project.

### 4.3 Projects — ✅ both inside the organisation

| Environment | Project ID | Project number | Parent org |
|---|---|---|---|
| Staging | `algominutes-staging` | `627101926311` | `327264144426` |
| Production | `algominutes-prod` | `758033737651` | `327264144426` |

Both verified `billingEnabled: true` against `01FDC8-CD8E58-F91D06`. Project IDs are **permanent**.

Moved with `gcloud beta projects move` — the command lives in the **beta** track, not GA.

**Deleted / shut down:** `My First Project` (×2, auto-generated), `email JS` (`email-js-470217`).
30-day recovery window from date of shutdown.

### 4.4 Budgets & cost controls — ✅ created

| Budget name | Scope | Monthly | Alerts |
|---|---|---|---|
| `algominutes-staging-budget` | Project `algominutes-staging` | A$50 | 50 / 80 / 100% |
| `algominutes-prod-budget` | ⚠️ Currently **whole billing account** — should be project `algominutes-prod` | A$1,000 | 50 / 90 / 100% |

⚠️ **Open item:** re-scope the prod budget to `algominutes-prod` only. As configured it measures
staging + prod combined, muddying per-environment attribution.

**Daily hard caps (circuit breaker, BUILD-PLAN §4.6):** staging A$20, prod A$200. Enforced **in code**,
not by GCP. Budget alerts notify; they do not stop spend. Both must exist before the first load test.

**Note on credits:** budgets track cost *after* credits. While the A$431 trial credit lasts, reported
spend stays near zero and alerts will not fire. Protection effectively begins when the credit is
exhausted.

**GCP "Spend cap enforcement" was deliberately NOT enabled** — it is in Preview, covers limited
services, and pauses usage outright. The application-level circuit breaker is preferred: it halts the
expensive AI pipeline while leaving the API serving.

**Staging sizing philosophy:** staging mirrors production's *architecture* exactly — same services,
same region, same IAM shape — at the **smallest viable tier** of each. It is not a capacity test of
production. Record tier differences in `docs/DECISIONS.md`.

### 4.5 Services (A4) — ✅ STAGING live · ⏳ prod authored, not applied

**Status (15 Aug 2026):** infrastructure is authored as **Terraform** in `infra/terraform/`
(modules/environment + envs/{staging,prod}); `terraform validate` passes both envs. Apply steps:
`docs/runbooks/gcp-provisioning.md`; prod-specific notes: `docs/runbooks/prod-firebase-config.md`.

- **`algominutes-staging`: ✅ APPLIED — 111 resources live** (`terraform apply` succeeded; Cloud SQL
  `edition = ENTERPRISE`, see DECISIONS A4).
- **`algominutes-prod`: ⏳ not yet applied.** Same Terraform, run from a `gcp-admin@algorythmos.com` shell.

**Firebase — staging** (`algominutes-staging`):
- Firebase enabled, **Blaze** (pay-as-you-go) plan.
- **Google sign-in** enabled (support email `gcp-admin@algorythmos.com`). Apple sign-in pending the Team ID.
- Apps registered: **Web** ("AlgoMinutes Web") and **Android** ("AlgoMinutes Android"). **iOS not
  registered** — blocked on the Apple Team ID (`TODO(A4-apple)`).
- Web appId `1:627101926311:web:3b656d832081e12b19ac82` · messagingSenderId `627101926311` (= project
  number). Android `google-services.json` is on disk at `apps/android/app/` (git-ignored). The web apiKey
  and full config live in `apps/web/.env` (git-ignored) — **not recorded here** (public but kept in .env).
- **Firebase Analytics is NOT initialised** in the web client (no `getAnalytics()` call); the config's
  `measurementId` is present but unused. Turning Analytics on is a deliberate A10 decision (privacy policy
  + Data Safety), not a default — see DECISIONS.

The §4.6 **daily-spend circuit breaker is implemented in code** (`packages/ai/src/spend-guard.cjs`, caps
staging A$20 / prod A$200), wired into the transcoder + summarizer; its spend reader is stubbed until A9.

What `terraform apply` creates per env (all `australia-southeast1`): 23 enabled APIs · a VPC + subnet +
private services access + Serverless VPC connector · Cloud SQL Postgres 16 (private IP) + `algominutes` DB
+ Secret-Manager password · the 3 buckets (staging recordings 7-day lifecycle) · 5 Cloud Tasks queues ·
Firestore (native) · Artifact Registry · the 7 `run-*` service accounts + least-privilege IAM.
**Not** created by Terraform: Cloud Run service deploys (A11), Firebase apps/configs (CLI, runbook §4),
budgets (already exist). Staging/prod tier differences are recorded in `docs/DECISIONS.md` (A4).

Per environment, region `australia-southeast1`:

- **Cloud Run:** `api`, `transcoder`, `summarizer`, `embedder`, `extractor`, `billing`, `notifier`
- **Cloud SQL (Postgres + pgvector):** instance `algominutes-<env>-pg`, database `algominutes`
- **Cloud Storage:** `algominutes-<env>-recordings`, `-imports`, `-scans`
  (7-day lifecycle rule on the staging recordings bucket)
- **Cloud Tasks queues:** `transcode`, `summarize`, `embed`, `extract`, `notify`
- **Firebase:** Auth (Google + Apple sign-in), Firestore (cache), Crashlytics, FCM
- **Vertex AI** (Gemini — Cloud Run only), **Speech-to-Text v2**

⚠️ **Firebase config files must be REGENERATED per environment, never copied** from the source
project: `google-services.json`, `GoogleService-Info.plist`, web config.

---

## 5. Apple

| Item | Status |
|---|---|
| Apple Developer Program | **Pending** — organisation enrolment; developer agreement signed 14 Aug 2026 |
| D-U-N-S number | **Applied for**; correspondence received 14 Aug — check whether issued |
| Team ID | `TODO` — replaces the source repo's `HX9DZ34625` (Integrant Biotechnology Ltd) |
| Code signing | **Automatic** (`CODE_SIGN_STYLE: Automatic` in `ios-native/project.yml`) |
| Provisioning profile | Not required while automatic signing is used |
| App Store Connect | Not yet created |
| Small Business Program | **Not yet applied** — reduces commission 30% → 15% |

⚠️ **Apple enrolment is the long pole.** It gates the Team ID, which gates the Apple half of A4, the
iOS release, and App Store Connect. **Apply for the Small Business Program before the first sale** —
worth roughly A$4.35 per subscriber per month at A$29.

---

## 6. Domains, DNS & email

| Domain | Registrar/DNS | Role |
|---|---|---|
| `algorythmos.com` | **Cloudflare** (DNS) | Primary — company site, GCP org identity |
| `algorythmos.com.au` | Cloudflare | Secondary |
| `algorythmos.fr` | Cloudflare | Secondary |
| `algominutes.com` | `TODO — confirm registrar` | Product web app |
| `algominutes.com.au` | `TODO — confirm registered` | Product, AU |

**Email: Zoho Mail** for all three `algorythmos` domains. MX, SPF, DKIM and DMARC configured and
verified. Confirmed working — Google Cloud invitations to `gcp-admin@algorythmos.com` were delivered
to Zoho during setup.

⚠️ **Never let Google (or any service) modify MX records.** Domain verification is always
TXT-record-only. Google's automated Cloudflare integration was deliberately declined during Cloud
Identity setup for exactly this reason.

---

## 7. Commercial accounts

| Service | Status | Notes |
|---|---|---|
| Stripe | **Exists** | ⚠️ Verify registered to **Algorythmos Pty Ltd with the ACN**, not the sole trader ABN |
| App Store Connect | Not created | Blocked on Apple enrolment |
| Google Play Console | Not created | One-off US$25. 15% applies to first US$1M automatically |
| Android upload keystore | Not created | Generate fresh — **never reuse the client's**. Enrol in Play App Signing. Losing the upload key is unrecoverable |

**Revenue rails (BUILD-PLAN §A9.4):** iOS StoreKit 2 (30%→15%), Android Play Billing (30%→15%),
Web Stripe (~2.9%). One entitlement source of truth in Postgres, keyed to the user, not the rail.

---

## 8. Outstanding actions

| # | Action | Owner | Priority |
|---|---|---|---|
| 1 | **Rotate the exposed Gemini API key** — `AIza…` in the *source* repo's git history (`test-gemini.js`, added `c265d2c`, deleted `4c93841`). Not in the new repo, but live in a public repo's history | Sam | **Urgent — still open** |
| 2 | Re-scope `algominutes-prod-budget` to the prod project only | Sam | Medium |
| 3 | Complete Apple Developer enrolment; record the Team ID | Sam | High — long lead time |
| 4 | Confirm ABN captured on the billing payments profile | Sam | Medium |
| 5 | Enable 2FA + recovery on both Google accounts | Sam | High |
| 6 | Confirm Stripe account is under the Pty Ltd / ACN | Sam | Medium |
| 7 | Move the billing account into the org (unavailable at setup — retry) | Sam | Low — cosmetic |
| 8 | Verify Bustle Studios reliably forwards post — now used for financial accounts | Sam | Low |
| 9 | Delete the stale clone `~/Documents/wasssup-meeting-main` | Sam | Low |

**Completed 15 Aug 2026:** Cloud Identity organisation created · both projects created and moved into
the org · billing account created under the Pty Ltd with an Organization payments profile · both
budgets created · junk projects shut down · `gcp-admin` granted Owner and Billing Admin.

---

## 9. Where credentials actually live

| Type | Location |
|---|---|
| Google account passwords, 2FA backup codes | Password manager |
| GCP service-account keys | Google Secret Manager (workload identity preferred — avoid key files entirely) |
| API keys (Gemini, STT, third-party) | Google Secret Manager, per environment |
| Stripe secret keys | Google Secret Manager |
| Apple / Play signing certificates | Encrypted offline backup + platform-managed signing |
| Android upload keystore + passwords | Encrypted offline backup — **irreplaceable** |
| CI secrets | GitHub Actions repository secrets |
| Cloudflare and Zoho logins | Password manager |

**Gitleaks runs on every push with an empty allowlist.** Any secret found in git is an incident:
rotate first, then purge history with `git filter-repo`.

---

## 10. Useful commands

```bash
# Confirm a project's org and number
gcloud projects describe algominutes-staging --format="value(parent.id,projectNumber)"

# Confirm billing is linked
gcloud beta billing projects describe algominutes-prod

# Move a project into the org (NOTE: beta track, not GA)
gcloud beta projects move <project-id> --organization=327264144426

# Grant org-level Project Creator (needed before a move can succeed)
gcloud organizations add-iam-policy-binding 327264144426 \
  --member="user:gcp-admin@algorythmos.com" \
  --role="roles/resourcemanager.projectCreator"
```

---

## 11. Related documents

| File | Contents |
|---|---|
| `docs/BUILD-PLAN.md` | The master build plan — phases, priorities, architecture |
| `docs/EXTRACTION-AUDIT.md` | A1 output — file-by-file provenance classification of the source repo |
| `docs/A4-CHECKLIST.md` | The 13 identifiers needed to unblock provisioning |
| `docs/DECISIONS.md` | Running log of decisions made during the build |
| `docs/BLOCKERS.md` | Batched open questions and deferrals |
| `docs/CONSENT.md` | Recording-consent design, pending legal opinion |
