import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// infra/terraform/modules/environment/alerting.tf alerts on log lines by their
// event name (jsonPayload.msg). Renaming one in code would disarm its alert
// silently, so every alerted event must still be logged somewhere.
const root = path.resolve(__dirname, '..');
const tf = fs.readFileSync(path.join(root, 'infra/terraform/modules/environment/alerting.tf'), 'utf8');
const block = tf.slice(tf.indexOf('log_alerts = {'), tf.indexOf('\n  }\n}', tf.indexOf('log_alerts = {')));
const events = [...block.matchAll(/^ {4}([a-z_]+) = \{/gm)].map((m) => m[1]);

function sources(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sources(p);
    return /\.(c?js|ts)$/.test(e.name) ? [p] : [];
  });
}
const code = [
  ...fs.readdirSync(path.join(root, 'services')).flatMap((s) => sources(path.join(root, 'services', s, 'src'))),
  ...fs.readdirSync(path.join(root, 'packages')).flatMap((p) => sources(path.join(root, 'packages', p, 'src'))),
].map((f) => fs.readFileSync(f, 'utf8')).join('\n');

describe('alerting.tf events', () => {
  it('parses the alerted events', () => {
    expect(events).toContain('storage_purge_stuck');
    expect(events.length).toBeGreaterThanOrEqual(8);
  });

  it.each(events)('%s is still logged by the code', (event) => {
    // log.error(...), log?.error?.(...), noteLog.warn(...): the event is the call's last argument.
    expect(code).toMatch(new RegExp(`\\.(error|warn|info)(\\?\\.)?\\([^;]*'${event}'\\)`, 's'));
  });
});
