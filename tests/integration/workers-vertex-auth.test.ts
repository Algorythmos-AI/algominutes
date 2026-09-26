import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as repo from '@algominutes/db';
import { pool, resetDb } from './helpers';

// The workers call Gemini through the ladder (gemini-call.cjs), which uses
// Vertex AI with the service's own identity (ADC). The summarizer and the
// transcoder's fast path still required GEMINI_API_KEY, a leftover from the
// public-API days, and nothing sets one (no Terraform, no deploy workflow), so
// on a real deploy every summary and every clip of 10 minutes or less failed
// with "GEMINI_API_KEY not set". These run both with no key in the env.
const require = createRequire(import.meta.url);
// The summarizer require()s @algominutes/db, which is TypeScript (tsx runs it in
// the image). Hand Node's require the module vitest already compiled.
const repoPath = require.resolve('@algominutes/db');
require.cache[repoPath] = { id: repoPath, filename: repoPath, loaded: true, exports: repo } as never;
const geminiCall = require('@algominutes/ai/gemini-call.cjs');
const realLadder = geminiCall.callGeminiWithLadder;

beforeEach(async () => {
  await resetDb();
  geminiCall.callGeminiWithLadder = realLadder;
});
afterAll(async () => {
  geminiCall.callGeminiWithLadder = realLadder;
  await require('../../services/summarizer/src/handler.js').pool().end();
  await pool.end();
  await repo.getPool().end();
});

const noop = () => {};
const log = { info: noop, warn: noop, error: noop, child: () => log };

describe('workers need no GEMINI_API_KEY (Vertex via ADC)', () => {
  it('the summarizer gets past setup with no key: a note that is gone is acknowledged, not thrown', async () => {
    const { handle } = require('../../services/summarizer/src/handler.js');
    const deps = { env: {}, log, traceId: 't', geminiCall: { callGeminiWithLadder: async () => { throw new Error('not reached'); } } };
    await expect(handle({ noteId: 'missing', workspaceId: 'ws-x' }, deps)).resolves.toBeUndefined();
  });

  it('the fast path calls the ladder with the audio inline and no API key, and writes real timestamps', async () => {
    const calls: any[] = [];
    geminiCall.callGeminiWithLadder = async (args: any) => {
      calls.push(args);
      return {
        model: 'gemini-3.5-flash',
        rawText: JSON.stringify({
          transcript: [{ speaker: 'A', text: 'hello', time: '00:05' }, { speaker: 'B', text: 'bye', time: '01:02' }],
          gist: 'g', actionItems: ['a'], keyDecisions: [],
        }),
      };
    };
    const fastPath = require('../../services/transcoder/src/fast-path.js');
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: async (sql: string, params: unknown[] = []) => { queries.push({ sql, params }); return { rows: [{ id: 'n1' }], rowCount: 1 }; },
      release: noop,
    };
    const db = {
      pool: () => ({ connect: async () => client }),
      upsertNoteStatus: async () => {},
      deleteTranscriptLinesForNote: async () => {},
      claimEmbedderEnqueue: async () => false,
      // The real repo function, over the fake client below.
      persistFastPathResult: require('@algominutes/db/pipeline-repo.cjs').persistFastPathResult,
    };
    const input = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fastpath-')), 'clip.m4a');
    fs.writeFileSync(input, Buffer.from('not really audio'));
    await fastPath.run({
      noteId: 'n1', workspaceId: 'ws-a', type: 'recording', mimeType: 'audio/mp4', inputLocal: input, durationSec: 62, log,
      deps: { db, mirror: { mirrorReady: async () => {} }, tasks: { enqueueEmbedder: async () => {} }, env: {} },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('apiKey');
    expect(calls[0].parts[0].inlineData).toMatchObject({ mimeType: expect.stringMatching(/^audio\//) });
    const starts = queries.filter((q) => q.sql.includes('INSERT INTO transcript_lines')).map((q) => q.params[1]);
    expect(starts).toEqual([5000, 62000]);
  });
});
