// The env services/meetings refuses to boot without (@algominutes/ai
// require-env.cjs). tests/tf-env-contract.test.ts checks Terraform sets each,
// non-blank, in every environment. Recall's key and webhook secret are NOT here:
// they're read from Secret Manager at run time (src/lib/secrets.js).
module.exports = {
  required: ['JOBS_SA_EMAIL', 'MEETINGS_URL', 'ALGOMINUTES_ENV'],
  exact: { WRITE_POSTGRES: 'true' },
  oneOf: [
    { label: 'a Postgres target', of: [['DATABASE_URL'], ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']] },
    { label: 'a GCP project', of: [['GOOGLE_CLOUD_PROJECT'], ['GCLOUD_PROJECT']] },
  ],
};
