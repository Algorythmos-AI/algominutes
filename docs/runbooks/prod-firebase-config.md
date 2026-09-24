# Runbook — repeat the staging Firebase/config wiring for PRODUCTION

Staging (`algominutes-staging`) is provisioned and its Firebase configs are wired. Production is the **same
steps against `algominutes-prod`** — with **separate config values that must never reuse staging's**. Run
from a shell authed as `algorythmos.france@gmail.com` (primary working account).

> ⚠️ **Never copy staging's config into prod.** Different project → different `apiKey`, `appId`,
> `messagingSenderId` (= prod project number `758033737651`), `authDomain`, `storageBucket`,
> `measurementId`. Copying staging values silently points prod at the staging backend.

## 1. Provision the infra (if not already applied)
Bootstrap the state bucket and apply, exactly as `gcp-provisioning.md` §1–2 but in the **prod** env:
```bash
gcloud storage buckets create gs://algominutes-prod-tfstate --project=algominutes-prod \
  --location=australia-southeast1 --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update gs://algominutes-prod-tfstate --versioning
cd infra/terraform/envs/prod && terraform init && terraform plan -out=tfplan   # REVIEW
terraform apply tfplan     # prod: deletion_protection ON, Firestore location PERMANENT
```

## 2. Firebase (console / CLI) — prod project
- Enable Firebase on `algominutes-prod` (**Blaze** plan).
- Enable **Google** sign-in (support email `gcp-admin@algorythmos.com`); add **Apple** once the Team ID exists.
- Register the **Web** and **Android** apps (bundle/appId `com.algorythmos.algominutes`). Register **iOS**
  only after the Apple Team ID lands (`TODO(A4-apple)`).

## 3. Wire the configs — prod values only
- **Android:** download a fresh `google-services.json` → `apps/android/app/google-services.json`
  **for the prod build variant** (git-ignored). Do not overwrite staging's with prod's in the same file —
  use build variants / separate checkouts / CI per env.
- **Web:** create a **prod** env file (e.g. `apps/web/.env.production` or the CI env for the prod deploy) —
  NOT the same `.env` staging uses. Populate the same 8 `VITE_*` names (see `apps/web/.env.example`) with
  the **prod** Web app's `firebase apps:sdkconfig web <APP_ID>` values. Set `VITE_API_BASE_URL` to the prod
  API host (`https://api.algominutes.com/v1`) once the api service is deployed (A11).
- Verify git-ignore before finishing: `git check-ignore -v apps/web/.env.production apps/android/app/google-services.json`.

## 4. Same checks as staging
- Confirm the web reads every `VITE_*` var (`firebase.ts` + `apiUrl.ts`) — no missing/extra.
- **Analytics stays OFF** unless deliberately enabled (A10): no `getAnalytics()` call. The `measurementId`
  may be present in config but must not be initialised without the privacy-policy + Data-Safety decision.
- Record the prod appId + messagingSenderId in `docs/INFRASTRUCTURE.md` §4 (never the apiKey).
- Run migrations against the prod Cloud SQL (`gcp-provisioning.md` §6).
- Re-scope `algominutes-prod-budget` to the prod project only.
