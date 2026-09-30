import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// CI's boot smoke (scripts/boot-smoke.sh) starts every image with a fake env. Each service refuses to boot
// without what its src/env-spec.cjs requires, so a new required variable must reach the smoke's env too, or
// the image's build check fails in CI (PR 26a added BILLING_URL, and only CI noticed). This checks it here.
const require = createRequire(import.meta.url);
const root = resolve(__dirname, '..');
const { checkEnv } = require('@algominutes/ai/require-env.cjs') as {
  checkEnv: (s: unknown, e: Record<string, string | undefined>) => string[];
};

const script = readFileSync(resolve(root, 'scripts/boot-smoke.sh'), 'utf8');
const block = /env_args=\(([\s\S]*?)\n\)/.exec(script);
const smokeEnv = Object.fromEntries(
  [...(block?.[1] ?? '').matchAll(/-e\s+([A-Z0-9_]+)=(\S+)/g)].map((m) => [m[1]!, m[2]!]),
);
const services = readdirSync(resolve(root, 'services')).filter((s) => existsSync(resolve(root, `services/${s}/src/env-spec.cjs`)));

describe('the boot smoke gives every service the env it requires', () => {
  it('reads the smoke\'s env and every spec', () => {
    expect(Object.keys(smokeEnv).length).toBeGreaterThan(10);
    expect(services).toEqual(expect.arrayContaining(['api', 'billing', 'meetings', 'db-job']));
  });

  it.each(services)('%s', (svc) => {
    expect(checkEnv(require(`../services/${svc}/src/env-spec.cjs`), smokeEnv)).toEqual([]);
  });
});
