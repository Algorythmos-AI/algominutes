import { describe, it, expect } from 'vitest';
import { MODULE, read, stripComments, balanced } from './helpers/terraform';

// Two things Google refused at the first staging apply (2026-09-26), which a
// plan can't catch: kept from coming back.
const tf = (f: string) => stripComments(read(`${MODULE}/${f}`));
const module = ['alerting.tf', 'monitoring.tf', 'firebase-rules.tf', 'budget.tf'].map(tf).join('\n');

/** The body of every `resource "<type>" "<name>" { ... }` of a type. */
function resources(type: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const re = new RegExp(`resource "${type}" "(\\w+)"\\s*\\{`, 'g');
  for (const m of module.matchAll(re)) out.push({ name: m[1], body: balanced(module, m.index! + m[0].length - 1) });
  return out;
}

describe('the apply-time refusals', () => {
  it('every alert policy filter names a resource.type (Monitoring refuses one without)', () => {
    const policies = resources('google_monitoring_alert_policy');
    expect(policies.length).toBeGreaterThanOrEqual(3);
    for (const p of policies) {
      const filters = [...p.body.matchAll(/filter\s*=\s*"((?:[^"\\]|\\.)*)"/g)].map((f) => f[1]);
      expect(filters.length, p.name).toBeGreaterThan(0);
      for (const f of filters) expect(f, `${p.name}: ${f}`).toMatch(/resource\.type\s*=/);
    }
  });

  it('the APIs that need a quota project on user credentials use the google.billing provider', () => {
    for (const type of ['google_firebaserules_ruleset', 'google_firebaserules_release', 'google_billing_budget']) {
      const found = resources(type);
      expect(found.length, type).toBeGreaterThan(0);
      for (const r of found) expect(r.body, `${type}.${r.name}`).toMatch(/^\s*provider\s*=\s*google\.billing\s*$/m);
    }
  });
});
