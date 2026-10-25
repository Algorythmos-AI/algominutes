import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Production's cost guards for the launch (plan rev 12, Stage 2): a daily spend cap the api and the transcoder
// enforce, and a monthly budget that alerts. This pins what's committed; the owner applies it (Apply P).
const root = readFileSync('infra/terraform/envs/prod/main.tf', 'utf8');
const setting = (name: string) => {
  const m = new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*(#.*)?$`, 'm').exec(root);
  return m ? m[1] : undefined;
};

describe('production’s launch cost guards', () => {
  it('caps a day’s paid work at A$60, explicitly, rather than spend-guard’s A$200 default', () => {
    expect(setting('daily_spend_cap_aud')).toBe('60');
  });

  it('alerts on a month past A$500', () => {
    expect(setting('monthly_budget')).toBe('500');
  });
});
