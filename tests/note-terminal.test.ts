import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// markNoteFailed mirrors 'error' only when Postgres failed the note, or when
// Postgres itself errored. The existence probe after a no-op UPDATE is a
// separate question: if it fails, Postgres has already answered "not failed",
// so nothing is mirrored (the note may well be ready) and the caller keeps the
// dead letter.
const require = createRequire(import.meta.url);
const { markNoteFailed } = require('../packages/db/src/note-terminal.cjs');

function fakes({ probe }: { probe: () => Promise<any> }) {
  const updates: any[] = [];
  const logs: Array<[string, string]> = [];
  let call = 0;
  const client = {
    release: () => {},
    query: async () => (call++ === 0 ? { rows: [], rowCount: 0 } : probe()),
  };
  const log = {
    info: (_o: unknown, m: string) => void logs.push(['info', m]),
    warn: (_o: unknown, m: string) => void logs.push(['warn', m]),
    error: (_o: unknown, m: string) => void logs.push(['error', m]),
  };
  return {
    updates,
    logs,
    args: {
      pool: { connect: async () => client },
      firestore: { doc: () => ({ update: async (d: any) => void updates.push(d) }) },
      noteId: 'n1', workspaceId: 'ws', message: 'm', log, event: 'ev',
    },
  };
}

describe('markNoteFailed, when its UPDATE matched nothing', () => {
  it('a failed existence probe mirrors nothing and reports the note as possibly there', async () => {
    const f = fakes({ probe: async () => { throw new Error('connection reset'); } });
    expect(await markNoteFailed(f.args)).toEqual({ failed: false, marked: false, pgErrored: false, exists: true, refunded: false, superseded: false, notice: null });
    expect(f.updates).toEqual([]);
    expect(f.logs).toContainEqual(['error', 'ev_exists_probe_failed']);
    expect(f.logs.map(([, m]) => m)).not.toContain('note_failed');
  });

  it('a note that is not there: exists false, nothing mirrored', async () => {
    const f = fakes({ probe: async () => ({ rows: [], rowCount: 0 }) });
    expect(await markNoteFailed(f.args)).toEqual({ failed: false, marked: false, pgErrored: false, exists: false, refunded: false, superseded: false, notice: null });
    expect(f.updates).toEqual([]);
  });

  it('a note that is there (ready): exists true, nothing mirrored', async () => {
    const f = fakes({ probe: async () => ({ rows: [{}], rowCount: 1 }) });
    expect(await markNoteFailed(f.args)).toEqual({ failed: false, marked: false, pgErrored: false, exists: true, refunded: false, superseded: false, notice: null });
    expect(f.updates).toEqual([]);
  });
});
