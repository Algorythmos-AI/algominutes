// The env this service refuses to boot without (@algominutes/ai require-env.cjs).
// index.js validates it at startup; tests/tf-env-contract.test.ts checks that
// Terraform sets every name here, non-blank, for every environment.
module.exports = {
  required: ['GCS_BUCKET'],
};
