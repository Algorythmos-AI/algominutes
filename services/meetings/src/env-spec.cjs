// The env services/meetings refuses to boot without (@algominutes/ai
// require-env.cjs). tests/tf-env-contract.test.ts checks Terraform sets each,
// non-blank, in every environment. Recall's key and webhook secret are NOT here:
// they're read from Secret Manager at run time (src/lib/secrets.js).
module.exports = {
  // TRANSCODER_URL and TASKS_PROJECT: where ingest queues a note's run (queueNoteRun fails the note without
  // them). GCS_BUCKET, where it writes the recording, is checked at use instead (lib/recordings-store.js): a
  // deploy that lands before the apply that sets it must still boot (tests/tf-env-contract.test.ts checks it).
  required: ['JOBS_SA_EMAIL', 'MEETINGS_URL', 'ALGOMINUTES_ENV', 'TRANSCODER_URL', 'TASKS_PROJECT'],
  exact: { WRITE_POSTGRES: 'true' },
  oneOf: [
    { label: 'a Postgres target', of: [['DATABASE_URL'], ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']] },
    { label: 'a GCP project', of: [['GOOGLE_CLOUD_PROJECT'], ['GCLOUD_PROJECT']] },
  ],
};
