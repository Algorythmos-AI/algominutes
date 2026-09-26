// The env this service refuses to boot without (@algominutes/ai require-env.cjs).
// index.js validates it at startup; tests/tf-env-contract.test.ts checks that
// Terraform sets every name here, non-blank, for every environment.
module.exports = {
  required: ['STORAGE_BUCKET', 'TRANSCODE_QUEUE', 'TASKS_LOCATION', 'TRANSCODER_URL', 'SUMMARIZER_URL', 'ALLOWED_ORIGINS'],
  exact: { WRITE_POSTGRES: 'true' },
  oneOf: [
    { label: 'a Postgres target', of: [['DATABASE_URL'], ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']] },
    { label: 'a GCP project', of: [['GOOGLE_CLOUD_PROJECT'], ['GCLOUD_PROJECT']] },
  ],
};
