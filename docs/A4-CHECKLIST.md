# A4 identifier checklist — fill in and hand back

A4 (provisioning) is blocked only on these. Fill each **VALUE** in; where a **default assumed** is
shown, either confirm it or overwrite it. Nothing here can be invented on your behalf (BUILD-PLAN
§Working-constraints). Never paste a private key / password into this file — for those, say only "created,
stored in Secret Manager" and keep the secret in Google Secret Manager (§4.2).

Legend: **Where** = exactly where to get it · **Format** = what it looks like · **Default** = what the
code currently assumes.

---

## Apple / iOS

### 1. Apple Developer Team ID
- **What:** Your Apple Developer Program team identifier (replaces the client's `HX9DZ34625`).
- **Where:** developer.apple.com → account → **Membership details** → "Team ID". (Requires the
  Algorythmos Apple Developer Program enrolment — if not enrolled yet, do that first at
  developer.apple.com/programs, ~A$149/yr, D-U-N-S number needed for an organisation.)
- **Format:** 10 chars, uppercase alphanumeric, e.g. `AB12CD34EF`.
- **Default assumed:** none.
- **VALUE:** `__________`

### 2. iOS bundle IDs (app + two extensions)
- **What:** The app's bundle identifier and the two broadcast-extension identifiers.
- **Where:** developer.apple.com → **Certificates, IDs & Profiles → Identifiers → +** (register each), or
  let Xcode create them on first archive. Must be lowercase reverse-DNS.
- **Format:** `com.algorythmos.algominutes`, `com.algorythmos.algominutes.BroadcastExtension`,
  `com.algorythmos.algominutes.BroadcastExtensionSetupUI`.
- **Default assumed:** exactly those three (currently the code still says `com.wassup.meeting*` — A5
  renames to whatever you confirm here).
- **VALUE (app):** `__________`  **(extension):** `__________`  **(setup UI):** `__________`

### 3. iOS provisioning profiles
- **What:** Distribution provisioning profile name(s) for the app (and extensions if using manual signing).
- **Where:** developer.apple.com → **Profiles → +** (App Store distribution), tied to the Team (#1) and
  the bundle IDs (#2). Or use Xcode **Automatic signing** and skip named profiles.
- **Format:** a name string, e.g. `AlgoMinutes App Store` (replaces `"Wassup App Store"`).
- **Default assumed:** Automatic signing (project.yml currently `CODE_SIGN_STYLE: Automatic`, no profile).
- **VALUE:** `__________`  (or write "automatic")

### 4. App Group identifier
- **What:** The App Group that carries the ReplayKit broadcast-extension → app audio handoff. **Get this
  right now** — retrofitting an App Group silently breaks the recording handoff (§A4).
- **Where:** developer.apple.com → **Identifiers → App Groups → +**. Enable it on the app + both
  extension identifiers under their **Capabilities**.
- **Format:** `group.` + reverse-DNS, e.g. `group.com.algorythmos.algominutes`.
- **Default assumed:** `group.com.algorythmos.algominutes` (currently `group.com.wassup.meeting`).
- **VALUE:** `__________`

---

## Android

### 8. Android applicationId + package
- **What:** The app's `applicationId` and Kotlin package path.
- **Where:** you choose it (must match the Play listing and the Firebase Android app). Lowercase reverse-DNS.
- **Format:** `com.algorythmos.algominutes` (package path `com/algorythmos/algominutes/`).
- **Default assumed:** `com.algorythmos.algominutes` (currently `com.wassup.meeting`; A5 renames).
- **VALUE:** `__________`

### 9. Android upload keystore + Play App Signing
- **What:** A **fresh** upload keystore (never reuse the client's) and Play App Signing enrolment.
- **Where:** generate locally: `keytool -genkeypair -v -keystore algominutes-upload.jks -alias upload
  -keyalg RSA -keysize 2048 -validity 9125`. Enrol Play App Signing when you create the app in Play
  Console → **Setup → App integrity**. **Store the upload key safely — losing it is unrecoverable.**
- **Format:** a `.jks` file + passwords (keystore + key). **Do NOT paste passwords here** — store in Secret
  Manager; note only "created".
- **Default assumed:** none.
- **VALUE:** keystore created? `☐`  · Play App Signing enrolled? `☐`

---

## GCP / Firebase (two environments)

### 5. GCP/Firebase project IDs — staging + production
- **What:** Two **separate** GCP projects (each is a Firebase project too), replacing `wassup-meeting`.
- **Where:** console.cloud.google.com → **Create project** (×2), then console.firebase.google.com → **Add
  project** → pick each existing GCP project. Enable billing on both.
- **Format:** lowercase, 6–30 chars, e.g. `algominutes-staging`, `algominutes-prod`.
- **Default assumed:** none (staging + production required, §4.1).
- **VALUE (staging):** `__________`  **(prod):** `__________`

### 6. GCP project numbers / FCM sender IDs (per env)
- **What:** The numeric project number (= FCM messaging sender ID) for each project. Regenerated with #5.
- **Where:** Firebase console → **Project settings → General** ("Project number"), or Cloud Console
  dashboard. Also **Cloud Messaging** tab for the Sender ID (same number).
- **Format:** 12-ish digits, e.g. `123456789012`.
- **Default assumed:** none.
- **VALUE (staging):** `__________`  **(prod):** `__________`

### 7. Firebase app configs — REGENERATE, never copy (per env)
- **What:** The per-app Firebase config files for each of the two projects. **Never copy the client's** —
  regenerate fresh.
  - `google-services.json` (Android)
  - `GoogleService-Info.plist` (iOS)
  - Web config (the `apiKey`/`authDomain`/… object → goes into the web `.env`, see below)
- **Where:** Firebase console → **Project settings → Your apps** → register an iOS app (bundle #2), an
  Android app (applicationId #8), and a Web app; **download** each config. Do this for **staging and prod**.
- **Format:** JSON / plist files (git-ignored — placed on disk / in CI, never committed); web values are
  public domain-restricted keys that go in `apps/web/.env` as `VITE_FIREBASE_*` (see `apps/web/.env.example`).
- **Default assumed:** none.
- **VALUE:** iOS plist ×2 `☐`  · Android json ×2 `☐`  · web config ×2 `☐`

### 10. Cloud Run / Cloud Tasks / Postgres / bucket names (per env)
- **What:** The names for the runtime infra each service uses, per environment.
- **Where:** stood up during A4 provisioning (Cloud SQL Postgres instance, Cloud Storage buckets, Cloud
  Tasks queues, Cloud Run service names). You pick the names; keep them lowercase.
- **Format / defaults assumed (confirm or override):**
  - Cloud SQL Postgres instance: `algominutes-<env>-pg` · DB name `algominutes`
  - Buckets: `algominutes-<env>-recordings`, `algominutes-<env>-imports`, `algominutes-<env>-scans`
  - Cloud Tasks: queue(s) `transcode`, `summarize`, `embed`, `extract`, `notify` in region `us-central1`
  - Cloud Run services: `api`, `transcoder`, `summarizer`, `embedder`, `extractor`, `billing`, `notifier`
- **VALUE (overrides, if any):** `__________`

---

## Commercial / domains / cost

### 11. Domain(s)
- **What:** The product + API hostnames (for CORS `ALLOWED_ORIGINS`, web hosting, API base).
- **Where:** your registrar; point DNS at Vercel/hosting + Cloud Run per A4/A8.
- **Format / default assumed:** `algominutes.com` (web), `api.algominutes.com` (API). Confirm you own them.
- **VALUE (web):** `__________`  **(api):** `__________`

### 12. GCP budget + daily spend-cap figures (§4.6)
- **What:** The monthly budget alert thresholds and the **hard daily spend cap** the pipeline circuit
  breaker trips on. **Set before the first load test**, not after.
- **Where:** Cloud Console → **Billing → Budgets & alerts** (per project). The daily cap is enforced in code
  by the circuit breaker (built in §4.6 / A9).
- **Format:** currency amounts, e.g. monthly budget A$`____`, alert at 50/80/100%; daily hard cap A$`____`.
- **Default assumed:** none (must be your numbers).
- **VALUE (monthly):** `__________`  **(daily hard cap):** `__________`

### 13. Stripe / App Store Connect / Play Console accounts
- **What:** The three billing rails (A9). **Enrol both store small-business programmes before the first
  sale** — highest-leverage commercial action.
- **Where:**
  - **App Store Connect:** appstoreconnect.apple.com (needs the Apple Developer org, #1). Apply for the
    **Small Business Program** (15% rate).
  - **Play Console:** play.google.com/console (one-time US$25). 15% applies to first US$1M automatically.
  - **Stripe:** dashboard.stripe.com → create the account for Algorythmos Pty Ltd (ABN needed).
- **Format:** account exists / IDs. Do NOT paste secret keys here — store in Secret Manager.
- **VALUE:** App Store Connect `☐`  (Small Business applied `☐`) · Play Console `☐` · Stripe `☐`

---

### Once returned
With #1–#13 in hand, A4 can: create the two GCP/Firebase projects, regenerate all configs, stand up
Cloud Run/Tasks/Postgres/buckets per env, set the Apple team/profile/App-Group and Android
keystore/package, and set budget alerts + the spend circuit breaker before any load test. A5 then applies
the confirmed bundle IDs / package / domain across the codebase.
