import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

// Every service with an image deploys to staging, and every public one is smoke-checked (RELEASE.md PR 18:
// meetings was built by CI and never deployed, so the notetaker ran a placeholder).
const wf = fs.readFileSync('.github/workflows/deploy-staging.yml', 'utf8');
const smoke = fs.readFileSync('scripts/smoke-staging.sh', 'utf8');
const tf = fs.readFileSync('infra/terraform/modules/environment/cloud-run.tf', 'utf8');
const services = fs.readdirSync('services').filter((s) => fs.existsSync(`services/${s}/Dockerfile`));

describe('the staging deploy', () => {
  it('knows every service with an image', () => {
    expect(services).toContain('meetings');
    const all = JSON.parse(/all='(\[[^']*\])'/.exec(wf)![1]) as string[];
    for (const s of services) {
      expect(all, s).toContain(s);
      expect(wf, s).toMatch(new RegExp(`\\n\\s+${s}:\\s+\\['services/${s}/\\*\\*'`));
    }
  });

  it('smoke-checks every public service: up, and ready', () => {
    const pub = JSON.parse(/public_services\s*=\s*(\[[^\]]*\])/.exec(tf)![1]) as string[];
    const listed = /PUBLIC=\(([^)]*)\)/.exec(smoke)![1].split(/\s+/).filter(Boolean);
    expect(listed.sort()).toEqual([...pub].sort());
    for (const s of pub.filter((p) => p !== 'api')) {
      expect(smoke, s).toMatch(new RegExp(`check_code ${s} "\\$${s}_url/health" 200`));
      expect(smoke, s).toMatch(new RegExp(`check_code ${s}-ready "\\$${s}_url/health/ready" 200`));
    }
  });
});
