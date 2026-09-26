import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

// A pipeline-repo catch that logs must not turn its failure into a TypeError
// when a caller passed no logger: it falls back to the shared one.
const require = createRequire(import.meta.url);
const repo = require('../packages/db/src/pipeline-repo.cjs');
const shared = require('@algominutes/ai/logger.cjs').logger;

describe('pipeline-repo without a logger', () => {
  it('recordPaidWork logs its failure on the shared logger and returns', async () => {
    const spy = vi.spyOn(shared, 'error').mockImplementation(() => {});
    const queryable = { query: async () => { throw new Error('insert refused'); } };
    await expect(repo.recordPaidWork(queryable, { noteId: 'n1', workspaceId: 'ws', uid: 'u', event: 'stt_call', audioSeconds: 60 }))
      .resolves.toBeUndefined();
    expect(spy.mock.calls.map((c) => c[1])).toEqual(['paid_work_record_failed']);
    spy.mockRestore();
  });

  it('completeChunkGate rethrows the original error when its rollback fails too', async () => {
    const spy = vi.spyOn(shared, 'error').mockImplementation(() => {});
    const client = {
      query: async (sql: string) => {
        if (sql === 'BEGIN') return {};
        if (sql === 'ROLLBACK') throw new Error('connection lost');
        throw new Error('gate failed');
      },
    };
    await expect(repo.completeChunkGate(client, { chunkId: 'c', noteId: 'n1', workspaceId: 'ws' })).rejects.toThrow('gate failed');
    expect(spy.mock.calls.map((c) => c[1])).toEqual(['chunk_gate_rollback_failed']);
    spy.mockRestore();
  });

  it('persistFastPathResult rethrows the original error when its rollback fails too', async () => {
    const spy = vi.spyOn(shared, 'error').mockImplementation(() => {});
    const client = {
      release: () => {},
      query: async (sql: string) => {
        if (sql === 'BEGIN') return {};
        if (sql === 'ROLLBACK') throw new Error('connection lost');
        throw new Error('persist failed');
      },
    };
    const pool = { connect: async () => client };
    await expect(repo.persistFastPathResult(pool, { noteId: 'n1', workspaceId: 'ws', lines: [], summary: { gist: 'g', actionItems: [], keyDecisions: [] }, model: 'm' }))
      .rejects.toThrow('persist failed');
    expect(spy.mock.calls.map((c) => c[1])).toEqual(['fast_path_rollback_failed']);
    spy.mockRestore();
  });
});
