import { describe, it, expect, vi } from 'vitest';

// runRecallPurgesSoon (services/api routes/meetings.js): after a deletion queued Recall purges, the api starts
// the meetings purge worker at once. Its 30-minute schedule is the backstop, so a failure is logged, never
// the deletion's (RELEASE.md PR 21).
const enqueued: any[] = [];
let fails = false;
vi.mock('@algominutes/ai/cloud-tasks.cjs', () => ({
  default: {
    enqueueTask: async (args: any) => {
      if (fails) throw new Error('tasks 503');
      enqueued.push(args);
    },
  },
}));
// @ts-expect-error: plain ESM route module, no type declarations
const { runRecallPurgesSoon } = await import('../services/api/src/routes/meetings.js');

const env = { MEETINGS_URL: 'https://meetings.test/', TASKS_PROJECT: 'p', TASKS_LOCATION: 'l', JOBS_SA_EMAIL: 'jobs@p.iam', MEETINGS_QUEUE: 'meetings' };
function logger() {
  const lines: any[] = [];
  const log = { info: (o: any, m: string) => lines.push({ level: 'info', m, ...o }), warn: (o: any, m: string) => lines.push({ level: 'warn', m, ...o }), error: (o: any, m: string) => lines.push({ level: 'error', m, ...o }) };
  return { log, lines };
}

describe('runRecallPurgesSoon', () => {
  it('enqueues purge_media on the meetings queue, to the meetings service, as run-jobs, on the deletion\'s trace', async () => {
    const { log, lines } = logger();
    expect(await runRecallPurgesSoon(env, { traceId: 'trace-del', log })).toBe(true);
    expect(enqueued[0]).toMatchObject({
      projectId: 'p', location: 'l', queue: 'meetings', targetUrl: 'https://meetings.test/tasks/purge_media',
      oidcServiceAccount: 'jobs@p.iam', payload: { kind: 'purge_media' }, traceId: 'trace-del',
      // One kick per 5-minute window: a run of deletions starts the worker once.
      taskId: `purge-kick-${Math.floor(Date.now() / 300_000)}`,
    });
    expect(lines.map((l) => l.m)).toEqual(['recall_purges_started']);
  });

  it('a failed enqueue, or no meetings service, is a warning and never the deletion\'s failure', async () => {
    fails = true;
    const a = logger();
    expect(await runRecallPurgesSoon(env, { traceId: 't', log: a.log })).toBe(false);
    expect(a.lines).toEqual([expect.objectContaining({ level: 'warn', m: 'recall_purges_start_failed' })]);
    fails = false;
    const b = logger();
    expect(await runRecallPurgesSoon({}, { traceId: 't', log: b.log })).toBe(false);
    expect(b.lines).toEqual([expect.objectContaining({ level: 'error', m: 'recall_purges_not_started' })]);
  });
});
