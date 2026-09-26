import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// CLAUDE.md §1: traceId is propagated across every async hop, so one recording
// is followable end to end. Every Cloud Task carries the enqueuer's traceId in
// its body (cloud-tasks.cjs), and every worker logs under it (logger.cjs
// traceIdFromTask).
const require = createRequire(import.meta.url);
const logger = require('@algominutes/ai/logger.cjs');
const cloudTasks = require('@algominutes/ai/cloud-tasks.cjs');

function fakeClient() {
  const created: any[] = [];
  return {
    created,
    queuePath: (p: string, l: string, q: string) => `projects/${p}/locations/${l}/queues/${q}`,
    createTask: async (req: any) => {
      created.push(req);
      return [{ name: `${req.parent}/tasks/t1` }];
    },
  };
}
const decodeBody = (req: any) => JSON.parse(Buffer.from(req.task.httpRequest.body, 'base64').toString('utf8'));
const baseArgs = {
  projectId: 'p', location: 'australia-southeast1', queue: 'summarize',
  targetUrl: 'https://summarizer.example', oidcServiceAccount: 'jobs@p.iam.gserviceaccount.com',
};

describe('traceIdFromTask', () => {
  const header = { 'x-cloud-trace-context': '105445aa7843bc8bf206b12000100000/1;o=1' };

  it('prefers the traceId the enqueuer carried in the body', () => {
    expect(logger.traceIdFromTask({ traceId: 'abc-123' }, header)).toBe('abc-123');
  });

  it('falls back to the trace header, then a fresh id', () => {
    expect(logger.traceIdFromTask({}, header)).toBe('105445aa7843bc8bf206b12000100000');
    expect(logger.traceIdFromTask(undefined, {})).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('ignores a body traceId that is not a plain id (wrong type, oversized, odd characters)', () => {
    for (const bad of [{ a: 1 }, 42, 'x'.repeat(129), 'two words', 'line\nbreak', '']) {
      expect(logger.traceIdFromTask({ traceId: bad }, header)).toBe('105445aa7843bc8bf206b12000100000');
    }
  });
});

describe('traceIdFrom (the request header)', () => {
  const h = (v: string) => ({ 'x-cloud-trace-context': v });

  it('takes the trace id with or without a span and options', () => {
    expect(logger.traceIdFrom(h('105445aa7843bc8bf206b12000100000/1;o=1'))).toBe('105445aa7843bc8bf206b12000100000');
    expect(logger.traceIdFrom(h('105445aa7843bc8bf206b12000100000;o=1'))).toBe('105445aa7843bc8bf206b12000100000');
    expect(logger.traceIdFrom(h('105445aa7843bc8bf206b12000100000'))).toBe('105445aa7843bc8bf206b12000100000');
  });

  // enqueueTask refuses an invalid id, so a malformed header must never become
  // the request's traceId (it would turn a kickoff into a 500).
  it('never returns an id enqueueTask would refuse', () => {
    for (const bad of ['abc def/1', '/1;o=1', '', 'x'.repeat(200)]) {
      const id = logger.traceIdFrom(h(bad));
      expect(logger.isTraceId(id)).toBe(true);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe('enqueueTask carries the traceId', () => {
  it('puts it in the task body, next to the payload', async () => {
    const client = fakeClient();
    await cloudTasks.enqueueTask({ ...baseArgs, payload: { noteId: 'n1', workspaceId: 'w1' }, traceId: 'trace-1', client });
    expect(decodeBody(client.created[0])).toEqual({ noteId: 'n1', workspaceId: 'w1', traceId: 'trace-1' });
  });

  it('the traceId argument wins over one already in the payload', async () => {
    const client = fakeClient();
    await cloudTasks.enqueueTask({ ...baseArgs, payload: { traceId: 'stale' }, traceId: 'trace-2', client });
    expect(decodeBody(client.created[0]).traceId).toBe('trace-2');
  });

  it('refuses to enqueue without a valid traceId', async () => {
    const client = fakeClient();
    await expect(cloudTasks.enqueueTask({ ...baseArgs, payload: {}, client })).rejects.toThrow(/missing traceId/);
    await expect(cloudTasks.enqueueTask({ ...baseArgs, payload: {}, traceId: 'a b', client })).rejects.toThrow(/missing traceId/);
    expect(client.created).toEqual([]);
  });
});

describe("the transcoder's tasks client", () => {
  const original = cloudTasks.enqueueTask;
  afterEach(() => { cloudTasks.enqueueTask = original; });

  it('passes the request traceId on every hop (self, summarize, embed)', async () => {
    const calls: any[] = [];
    cloudTasks.enqueueTask = async (args: any) => { calls.push(args); return 'task'; };
    const { makeClient } = require('../services/transcoder/src/tasks-client.js');
    const tasks = makeClient({ env: {}, log: null, traceId: 'trace-3' });
    await tasks.enqueue({ kind: 'stt-poll' });
    await tasks.enqueueSummarizer({ noteId: 'n' });
    await tasks.enqueueEmbedder({ noteId: 'n' });
    expect(calls.map((c) => c.traceId)).toEqual(['trace-3', 'trace-3', 'trace-3']);
  });

  // The kickoff's uid rides along too, so every worker's logs can name the user.
  it('carries the uid on every hop, and leaves payloads alone without one', async () => {
    const calls: any[] = [];
    cloudTasks.enqueueTask = async (args: any) => { calls.push(args); return 'task'; };
    const { makeClient } = require('../services/transcoder/src/tasks-client.js');
    const tasks = makeClient({ env: {}, log: null, traceId: 't', uid: 'u-1' });
    await tasks.enqueue({ kind: 'stt-poll', noteId: 'n' });
    await tasks.enqueueSummarizer({ noteId: 'n' });
    await tasks.enqueueEmbedder({ noteId: 'n' });
    expect(calls.map((c) => c.payload.uid)).toEqual(['u-1', 'u-1', 'u-1']);
    calls.length = 0;
    await makeClient({ env: {}, log: null, traceId: 't' }).enqueueSummarizer({ noteId: 'n' });
    expect(calls[0].payload).toEqual({ noteId: 'n' });
  });

  it('the api puts the caller uid on the tasks it starts', () => {
    const kickoff = fs.readFileSync('services/api/src/routes/process-intelligence.js', 'utf8');
    const regen = fs.readFileSync('services/api/src/routes/regenerate-summary.js', 'utf8');
    expect(kickoff).toMatch(/kind: 'kickoff',[\s\S]*?uid: callerUid,/);
    expect(regen).toMatch(/summaryGeneration: claimed\.summary_generation,[\s\S]*?uid: req\.uid,/);
  });
});

describe('the notice enqueue (@algominutes/ai/notify.cjs)', () => {
  const env = { NOTIFIER_URL: 'https://notifier.example', TASKS_PROJECT: 'p', JOBS_SA_EMAIL: 'jobs@p.iam.gserviceaccount.com' };
  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("carries the recording's traceId, and logs with the user, workspace and note", async () => {
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
    const calls: any[] = [];
    const lines: any[] = [];
    const log = {
      child(fields: any) { return { ...log, info: (o: any, m: string) => lines.push({ ...fields, ...o, m }) }; },
      info() {}, warn() {}, error() {},
    };
    const { enqueueNotice, noticeTaskId } = require('@algominutes/ai/notify.cjs');
    const notice = { id: '42', noteId: 'n1', workspaceId: 'w1', uid: 'u1', kind: 'note_ready' };
    const outcome = await enqueueNotice({ notice, traceId: 'trace-4', log, enqueueTask: async (args: any) => { calls.push(args); return 'task'; } });
    expect(outcome).toBe('enqueued');
    expect(calls[0].traceId).toBe('trace-4');
    expect(calls[0].payload).toEqual({ type: 'note_ready', noteId: 'n1', workspaceId: 'w1', uid: 'u1', noticeId: '42' });
    // One task per notice, whoever enqueues it: led by a hash, not the sequence.
    expect(calls[0].taskId).toBe(noticeTaskId('42'));
    expect(noticeTaskId('42')).toMatch(/^[0-9a-f]{12}-notice-42$/);
    expect(noticeTaskId('43').slice(0, 12)).not.toBe(noticeTaskId('42').slice(0, 12));
    expect(lines).toContainEqual(expect.objectContaining({ m: 'notify_enqueued', traceId: 'trace-4', userId: 'u1', workspaceId: 'w1', noteId: 'n1', noticeId: '42' }));
  });

  it('a task of that name already there is reported as already queued, not enqueued', async () => {
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
    const lines: string[] = [];
    const log = { child() { return log; }, info: (_o: any, m: string) => void lines.push(m), warn() {}, error() {} };
    const { enqueueNotice } = require('@algominutes/ai/notify.cjs');
    const outcome = await enqueueNotice({
      notice: { id: '7', noteId: 'n', workspaceId: 'w', uid: 'u', kind: 'note_ready' }, traceId: 't', log,
      enqueueTask: async (a: any) => { a.onExisting(); return 'tasks/x'; },
    });
    expect(outcome).toBe('already_queued');
    expect(lines).toEqual(['notify_already_queued']);
  });

  it('a logger with no child() still gets every field on the line', async () => {
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
    const errors: any[] = [];
    const log = { error: (o: any, m: string) => void errors.push({ ...o, m }) };
    const { enqueueNotice } = require('@algominutes/ai/notify.cjs');
    await enqueueNotice({
      notice: { id: '8', noteId: 'n', workspaceId: 'w', uid: 'u', kind: 'note_failed' }, traceId: 't-8', log,
      enqueueTask: async () => { throw new Error('down'); },
    });
    expect(errors).toEqual([expect.objectContaining({ m: 'notify_enqueue_failed', traceId: 't-8', userId: 'u', workspaceId: 'w', noteId: 'n', noticeId: '8' })]);
  });

  it('never throws: a failed enqueue is logged and reported', async () => {
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
    const errors: string[] = [];
    const log = { child() { return log; }, info() {}, warn() {}, error: (_o: any, m: string) => void errors.push(m) };
    const { enqueueNotice } = require('@algominutes/ai/notify.cjs');
    const outcome = await enqueueNotice({
      notice: { id: '1', noteId: 'n', workspaceId: 'w', uid: 'u', kind: 'note_failed' }, traceId: 't', log,
      enqueueTask: async () => { throw new Error('tasks down'); },
    });
    expect(outcome).toBe('failed');
    expect(errors).toEqual(['notify_enqueue_failed']);
  });
});

// Every enqueueTask({...}) call in server code must pass a traceId property.
// (The runtime refuses otherwise, but this catches it before a deploy.)
describe('every enqueueTask call site passes traceId', () => {
  const ROOTS = ['services', 'packages', 'functions'];
  const skip = (p: string) => /(^|\/)(node_modules|dist|build|generated|test)(\/|$)/.test(p);
  function* files(dir: string): Generator<string> {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (skip(p)) continue;
      if (fs.statSync(p).isDirectory()) yield* files(p);
      else if (/\.(c|m)?[jt]s$/.test(name) && !name.endsWith('.d.ts')) yield p;
    }
  }

  it('finds the call sites, and each one names traceId', () => {
    const sites: string[] = [];
    const missing: string[] = [];
    for (const root of ROOTS) {
      for (const f of files(root)) {
        const src = fs.readFileSync(f, 'utf8');
        if (!src.includes('enqueueTask(')) continue;
        const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, /\.tsx?$/.test(f) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
            const arg = node.arguments[0];
            if (name === 'enqueueTask' && arg && ts.isObjectLiteralExpression(arg)) {
              const where = `${f}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
              sites.push(where);
              const named = arg.properties.some((p) => p.name && ts.isIdentifier(p.name) && p.name.text === 'traceId');
              if (!named) missing.push(where);
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(sf);
      }
    }
    // api, transcoder, summarizer and embedder queues, plus the notices (notify.cjs).
    expect(sites.length).toBeGreaterThanOrEqual(6);
    expect(missing).toEqual([]);
  });
});
