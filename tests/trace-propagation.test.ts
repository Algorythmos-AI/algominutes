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
});

describe('the notify hooks', () => {
  const original = cloudTasks.enqueueTask;
  const env = { NOTIFIER_URL: 'https://notifier.example', TASKS_PROJECT: 'p', JOBS_SA_EMAIL: 'jobs@p.iam.gserviceaccount.com' };
  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    cloudTasks.enqueueTask = original;
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  for (const svc of ['transcoder', 'summarizer']) {
    it(`${svc}: carries the traceId, and logs with the user and workspace`, async () => {
      for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
      const calls: any[] = [];
      cloudTasks.enqueueTask = async (args: any) => { calls.push(args); return 'task'; };
      const children: any[] = [];
      const lines: any[] = [];
      const log = {
        child(fields: any) { children.push(fields); return { ...log, info: (o: any, m: string) => lines.push({ ...fields, ...o, m }) }; },
        info() {}, warn() {}, error() {},
      };
      const { enqueueNotify } = require(`../services/${svc}/src/terminal-hooks.js`);
      await enqueueNotify({ type: 'note_ready', noteId: 'n1', workspaceId: 'w1', uid: 'u1', traceId: 'trace-4', log });
      expect(calls[0].traceId).toBe('trace-4');
      expect(lines).toContainEqual(expect.objectContaining({ m: 'notify_enqueued', userId: 'u1', workspaceId: 'w1', noteId: 'n1' }));
    });
  }
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
    expect(sites.length).toBeGreaterThanOrEqual(7);
    expect(missing).toEqual([]);
  });
});
