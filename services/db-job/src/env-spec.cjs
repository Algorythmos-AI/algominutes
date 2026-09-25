// The env this service refuses to boot without (@algominutes/ai require-env.cjs).
// index.js validates it at startup; tests/tf-env-contract.test.ts checks that
// Terraform sets every name here, non-blank, for every environment.
module.exports = {
  exact: { WRITE_POSTGRES: 'true' },
  oneOf: [
    { label: 'a Postgres target', of: [['DATABASE_URL'], ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']] },
  ],
};
