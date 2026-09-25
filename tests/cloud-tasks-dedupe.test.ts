import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// A named task is idempotent: Cloud Tasks refuses a second create with the same
// name (ALREADY_EXISTS), and enqueueTask treats that as done, so a replayed
// kickoff or a duplicate poll chain collapses into the running one.
const require = createRequire(import.meta.url);
const cloudTasks = require('@algominutes/ai/cloud-tasks.cjs');
const route = require('../services/transcoder/src/route.js');

function client(createErr?: any) {
  const created: any[] = [];
  return {
    created,
    queuePath: (p: string, l: string, q: string) => `projects/${p}/locations/${l}/queues/${q}`,
    createTask: async (req: any) => {
      created.push(req);
      if (createErr) throw createErr;
      return [{ name: req.task.name || `${req.parent}/tasks/auto` }];
    },
  };
}
const args = {
  projectId: 'p', location: 'australia-southeast1', queue: 'transcode', targetUrl: 'https://t.example',
  oidcServiceAccount: 'jobs@p.iam.gserviceaccount.com', traceId: 'trace-1', payload: { kind: 'stt-poll' },
};

describe('enqueueTask taskId', () => {
  it('names the task when given one, and leaves it unnamed otherwise', async () => {
    const c = client();
    expect(await cloudTasks.enqueueTask({ ...args, client: c, taskId: 'abc-stt-poll-0' }))
      .toBe('projects/p/locations/australia-southeast1/queues/transcode/tasks/abc-stt-poll-0');
    await cloudTasks.enqueueTask({ ...args, client: c });
    expect(c.created.map((r) => r.task.name)).toEqual([
      'projects/p/locations/australia-southeast1/queues/transcode/tasks/abc-stt-poll-0', undefined,
    ]);
  });

  it('a duplicate name (ALREADY_EXISTS) is done, and logged; other errors still throw', async () => {
    const infos: string[] = [];
    const log = { info: (_o: unknown, m: string) => void infos.push(m) };
    const dup = Object.assign(new Error('6 ALREADY_EXISTS: Requested entity already exists'), { code: 6 });
    await expect(cloudTasks.enqueueTask({ ...args, client: client(dup), taskId: 'x-1', log })).resolves.toMatch(/tasks\/x-1$/);
    expect(infos).toEqual(['task_already_exists']);
    // Unnamed, the same error is not a duplicate of anything: it throws.
    await expect(cloudTasks.enqueueTask({ ...args, client: client(dup) })).rejects.toThrow(/ALREADY_EXISTS/);
    await expect(cloudTasks.enqueueTask({ ...args, client: client(new Error('unavailable')), taskId: 'x-2' })).rejects.toThrow(/unavailable/);
  });

  it('refuses a task id Cloud Tasks would reject', async () => {
    for (const bad of ['', 'has space', 'slash/inside', 'x'.repeat(501), 42]) {
      await expect(cloudTasks.enqueueTask({ ...args, client: client(), taskId: bad })).rejects.toThrow(/taskId/);
    }
  });
});

describe('routeForDuration', () => {
  it('routes by length, and refuses an unknown one instead of defaulting to the fast path', () => {
    expect(route.routeForDuration(599)).toBe('fast');
    expect(route.routeForDuration(4 * 3600)).toBe('chunked');
    for (const bad of [undefined, NaN, 0, -1, Infinity, '600']) {
      expect(() => route.routeForDuration(bad)).toThrow(/unknown duration/);
    }
  });
});
