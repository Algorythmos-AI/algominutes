// The env this service refuses to boot without (@algominutes/ai require-env.cjs).
// index.js validates it at startup; tests/tf-env-contract.test.ts checks that
// Terraform sets every name here, non-blank, for every environment.
// BILLING_URL and JOBS_SA_EMAIL: /tasks/* checks each OIDC token was minted for this service, as run-jobs.
// They're soft: Apply B set them after the image needing them merged, and a boot-fatal check crash-looped
// every staging deploy from #281 (RELEASE.md rev 11, H1a). Without them billing still serves its webhooks and
// checkout, logs billing_config_missing, and /tasks/* answers 503 (task-auth.cjs), which Cloud Scheduler retries.
// The App Store Server API's key is NOT here: it's read from Secret Manager at run time
// (lib/app-store-server.js), and the reconcile task does nothing until it's set.
module.exports = {
  required: [],
  soft: ['BILLING_URL', 'JOBS_SA_EMAIL'],
  exact: { WRITE_POSTGRES: 'true' },
  oneOf: [
    { label: 'a Postgres target', of: [['DATABASE_URL'], ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']] },
    { label: 'a GCP project', of: [['GOOGLE_CLOUD_PROJECT'], ['GCLOUD_PROJECT']] },
  ],
};
