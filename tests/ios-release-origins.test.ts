import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

// Cloud Run URLs are deterministic: https://<service>-<project number>.<region>.run.app
// (infra/terraform/modules/environment/cloud-run.tf). The iPhone's builds name those URLs in project.yml, so each
// configuration must carry the project number of the environment it talks to, or a Release archive ships pointed
// at a project that isn't production.
const tfvars = (env: string, key: string) =>
  fs.readFileSync(`infra/terraform/envs/${env}/terraform.tfvars`, 'utf8').match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'))?.[1];

const config = (name: string) => {
  const yml = fs.readFileSync('apps/ios/project.yml', 'utf8');
  const block = yml.split(new RegExp(`\\n    ${name}:\\n`))[1]?.split(/\n    [A-Za-z]+:\n/)[0] ?? '';
  const value = (key: string) => block.match(new RegExp(`^\\s+${key}:\\s*(\\S+)`, 'm'))?.[1];
  return { api: value('API_BASE_URL'), billing: value('BILLING_BASE_URL') };
};

describe('the iPhone builds talk to their own environment', () => {
  const region = tfvars('prod', 'region');

  it.each([
    ['Release', 'prod'],
    ['Staging', 'staging'],
    ['Debug', 'staging'],
  ])('%s uses %s\'s Cloud Run origins', (name, env) => {
    const number = tfvars(env, 'project_number');
    expect(number).toMatch(/^\d+$/);
    expect(config(name)).toEqual({
      api: `https://api-${number}.${region}.run.app`,
      billing: `https://billing-${number}.${region}.run.app`,
    });
  });
});
