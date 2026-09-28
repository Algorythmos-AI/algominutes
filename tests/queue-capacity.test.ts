import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// A queue must never dispatch more at once than its service can serve: past max
// instances x request concurrency, Cloud Run answers 429, Cloud Tasks counts it
// as a failed attempt, and a burst dead-letters notes. main.tf derives each
// queue's max_concurrent_dispatches from the connection budget and the
// service's concurrency; this pins the wiring and the resulting numbers.
const read = (f: string) => readFileSync(f, 'utf8');
const main = read('infra/terraform/modules/environment/main.tf');
const run = read('infra/terraform/modules/environment/cloud-run.tf');
const budget = (env: string) => JSON.parse(read(`infra/terraform/envs/${env}/connection-budget.json`));

const QUEUE_SERVICE: Record<string, string> = {
  transcode: 'transcoder', summarize: 'summarizer', embed: 'embedder', extract: 'extractor', notify: 'notifier', meetings: 'meetings',
};
const concurrencyOf = (svc: string) => {
  const m = new RegExp(`\\n\\s*${svc}\\s*=\\s*\\{[^}]*concurrency\\s*=\\s*(\\d+)`).exec(run);
  if (!m) throw new Error(`no concurrency for ${svc} in cloud-run.tf`);
  return Number(m[1]);
};

describe('queue dispatch capacity', () => {
  it('every queue takes max_concurrent_dispatches from queue_capacity, not a constant', () => {
    expect(main).toMatch(/max_concurrent_dispatches\s*=\s*local\.queue_capacity\[each\.value\]/);
    expect(main).not.toMatch(/max_concurrent_dispatches\s*=\s*\d+/);
    expect(main).toMatch(/max_instances \* local\.service_config\[svc\]\.concurrency/);
  });

  it('maps each queue to the service its tasks are sent to', () => {
    for (const [q, svc] of Object.entries(QUEUE_SERVICE)) {
      expect(main, q).toMatch(new RegExp(`\\n\\s*${q}\\s*=\\s*"${svc}"`));
    }
    // The transcoder's own hops: transcode goes back to the transcoder, summarize and embed onward.
    const client = read('services/transcoder/src/tasks-client.js');
    expect(client).toMatch(/queue: cfg\.transcodeQueue,\s*targetUrl: cfg\.transcoderUrl/);
    expect(client).toMatch(/queue: cfg\.summarizeQueue,\s*targetUrl: cfg\.summarizerUrl/);
    expect(client).toMatch(/queue: cfg\.embedQueue,\s*targetUrl: cfg\.embedderUrl/);
  });

  it.each(['staging', 'prod'])('%s: each queue can dispatch exactly what its service can take at once', (env) => {
    const b = budget(env);
    for (const [q, svc] of Object.entries(QUEUE_SERVICE)) {
      const capacity = b.services[svc].max_instances * concurrencyOf(svc);
      expect(capacity, `${env} ${q}`).toBeGreaterThanOrEqual(1);
      // The old flat 50 was above every service's capacity; the transcoder is the tightest.
      expect(capacity, `${env} ${q}`).toBeLessThanOrEqual(50);
    }
    expect(b.services.transcoder.max_instances * concurrencyOf('transcoder')).toBe(env === 'staging' ? 2 : 4);
  });
});
