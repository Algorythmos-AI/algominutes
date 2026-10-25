import { describe, it, expect } from 'vitest';
// @ts-expect-error: a plain .mjs script, no types
import { removalProblems } from '../scripts/tfplan-removals.mjs';

// A saved plan fixes its variables: one made without TF_VAR_alert_emails or TF_VAR_admin_uids removes the alert
// e-mail channels (alerts then e-mail nobody) and the admin allowlist (the admin view answers 403), and nothing
// says so (docs/runbooks/production-incident.md §6). check-tfplan-env.mjs refuses such a plan unless the removal is
// meant (--allow-removals).
const channel = (email: string, actions: string[]) => ({
  address: `module.environment.google_monitoring_notification_channel.email["${email}"]`,
  type: 'google_monitoring_notification_channel',
  change: { actions, before: actions.includes('create') ? null : { type: 'email' }, after: actions.includes('delete') && !actions.includes('create') ? null : { type: 'email' } },
});
const service = (name: string, before: Record<string, string> | null, after: Record<string, string> | null) => ({
  address: `module.environment.google_cloud_run_v2_service.services["${name}"]`,
  type: 'google_cloud_run_v2_service',
  change: {
    actions: before && after ? ['update'] : before ? ['delete'] : ['create'],
    before: before && { name, template: [{ containers: [{ env: Object.entries(before).map(([k, v]) => ({ name: k, value: v })) }] }] },
    after: after && { name, template: [{ containers: [{ env: Object.entries(after).map(([k, v]) => ({ name: k, value: v })) }] }] },
  },
});
const planned = (channels: number) => ({
  root_module: { child_modules: [{ resources: Array.from({ length: channels }, () => ({ type: 'google_monitoring_notification_channel' })) }] },
});
const plan = (resource_changes: unknown[], channels = 1) => ({ resource_changes, planned_values: planned(channels) });

describe('a saved plan that removes what a forgotten TF_VAR would', () => {
  it('passes a plan that keeps every channel and every env var', () => {
    expect(removalProblems(plan([channel('a@example.test', ['no-op']), service('api', { ADMIN_UIDS: 'u1', X: '1' }, { ADMIN_UIDS: 'u1', X: '2' })]))).toEqual([]);
  });

  it('refuses a plan that deletes an alert e-mail channel', () => {
    const problems = removalProblems(plan([channel('a@example.test', ['delete']), channel('b@example.test', ['no-op'])]));
    expect(problems).toEqual(['deletes 1 alert e-mail channel(s): was TF_VAR_alert_emails exported? (--allow-removals if meant)']);
    // The address isn't printed: it holds the e-mail.
    expect(problems.join()).not.toContain('a@example.test');
  });

  it('refuses a plan that leaves no alert e-mail channel at all', () => {
    expect(removalProblems(plan([service('api', { A: '1' }, { A: '1' })], 0))).toEqual([
      'no alert e-mail channel after this plan: alerts would e-mail nobody (set TF_VAR_alert_emails)',
    ]);
  });

  it('refuses a plan that drops an env var a live service has (ADMIN_UIDS, a switch)', () => {
    expect(removalProblems(plan([service('api', { ADMIN_UIDS: 'u1', BROADCAST_CAPTURE: 'on', X: '1' }, { X: '1' })]))).toEqual([
      'service api: drops env ADMIN_UIDS, BROADCAST_CAPTURE (a TF_VAR not exported? --allow-removals if meant)',
    ]);
  });

  it('a recreated channel (replace) or a new service is no removal', () => {
    expect(removalProblems(plan([channel('a@example.test', ['delete', 'create']), service('new', null, { A: '1' })]))).toEqual([]);
  });

  it('a removal that is meant passes with --allow-removals, except a plan with no channel left', () => {
    const p = plan([channel('a@example.test', ['delete']), service('api', { ADMIN_UIDS: 'u1' }, {})]);
    expect(removalProblems(p, { allowRemovals: true })).toEqual([]);
    expect(removalProblems(plan([], 0), { allowRemovals: true })).toHaveLength(1);
  });
});
