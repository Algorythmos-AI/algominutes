import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
// @ts-expect-error — plain .mjs script, no type declarations
import { classify, hasContractMarker } from '../scripts/check-migration-expand.mjs';

type Finding = { rule: string };
const rules = (sql: string) => (classify(sql) as Finding[]).map((f) => f.rule);

describe('migration expand-only classifier', () => {
  it('passes pure expand DDL', () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS bookmarks (id uuid PRIMARY KEY, note_id text NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS bookmarks_note_uidx ON bookmarks(note_id);
      ALTER TABLE bookmarks ADD CONSTRAINT bookmarks_note_fk FOREIGN KEY (note_id) REFERENCES notes(id);
      ALTER TABLE notes ADD COLUMN IF NOT EXISTS paused_ms integer;
      ALTER TABLE notes ADD COLUMN IF NOT EXISTS pause_count integer NOT NULL DEFAULT 0;
      ALTER TABLE notes ALTER COLUMN title DROP NOT NULL;
      CREATE INDEX IF NOT EXISTS notes_paused_idx ON notes(paused_ms);`;
    expect(rules(sql)).toEqual([]);
  });

  it.each([
    ['drop', 'ALTER TABLE shares DROP COLUMN IF EXISTS token;'],
    ['drop', 'DROP TABLE legacy_things;'],
    ['rename', 'ALTER TABLE notes RENAME COLUMN title TO name;'],
    ['set-not-null', 'ALTER TABLE shares ALTER COLUMN expires_at SET NOT NULL;'],
    ['type-change', 'ALTER TABLE notes ALTER COLUMN duration_ms TYPE bigint;'],
    ['type-change', 'ALTER TABLE notes ALTER duration_ms SET DATA TYPE bigint;'],
    ['not-null-without-default', 'ALTER TABLE notes ADD COLUMN locale text NOT NULL;'],
    ['add-constraint', 'ALTER TABLE notes ADD CONSTRAINT notes_dur_ck CHECK (duration_ms >= 0);'],
    ['unique-index', 'CREATE UNIQUE INDEX shares_token_hash_key ON shares(token_hash);'],
  ])('flags %s', (rule, sql) => {
    expect(rules(sql)).toContain(rule);
  });

  it('ignores DDL words inside comments and string literals', () => {
    expect(rules(`-- we will DROP COLUMN token later\n/* RENAME */ INSERT INTO plans (id) VALUES ('DROP TABLE x');`)).toEqual([]);
  });

  it('recognises the contract marker only as a comment line with a reason', () => {
    expect(hasContractMarker('-- contract: no code reads shares.token since #41\nALTER TABLE shares DROP COLUMN token;')).toBe(true);
    expect(hasContractMarker('-- contract:\nALTER TABLE shares DROP COLUMN token;')).toBe(false);
    expect(hasContractMarker('ALTER TABLE shares DROP COLUMN token; -- not a contract: marker')).toBe(false);
  });

  it('on the real history, flags exactly the migrations that were not pure expand', () => {
    const dir = resolve(__dirname, '../packages/db/migrations');
    const flagged = readdirSync(dir)
      .filter((f) => /^\d{3}_.*\.sql$/.test(f))
      .filter((f) => classify(readFileSync(join(dir, f), 'utf-8')).length > 0)
      .sort();
    // 002 + 009: unique indexes on existing tables (ON CONFLICT targets);
    // 006: DROP COLUMN token, SET NOT NULL, unique index on shares.
    expect(flagged).toEqual(['002_chunked_pipeline.sql', '006_shares_hardening.sql', '009_reverse_trial_and_rails.sql']);
  });
});
