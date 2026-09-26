import { describe, it, expect } from 'vitest';
// @ts-expect-error: plain ESM script, no type declarations
import { findDirectWrites } from '../scripts/check-no-direct-pg-writes.mjs';

// The Postgres-writes gate (CLAUDE.md §1): what it must catch, and what it must not.
const writes = (code: string) => findDirectWrites('probe.js', code).length;

describe('check-no-direct-pg-writes', () => {
  it.each([
    ['q(`UPDATE notes SET status = $2 WHERE id = $1`)'],
    ['q(`UPDATE notes n SET x = 1`)'],
    ["q('UPDATE ONLY notes SET a = 1')"],
    ["q('UPDATE ' + 'notes SET a = 1')"],
    ['q(`UPDATE ${table} SET a = 1`)'],
    [`q('DELETE FROM public."notes" WHERE id = $1')`],
    ["q('INSERT INTO shares (a) VALUES ($1)')"],
    ['q(`INSERT INTO transcript_lines (note_id, text)\n  VALUES ($1, $2)`)'],
    ["q('TRUNCATE TABLE notes')"],
    ['q(`MERGE INTO notes USING x ON y`)'],
  ])('catches %s', (code) => {
    expect(writes(code)).toBe(1);
  });

  it.each([
    ["res.json({ error: 'Failed to update speakers' })"],
    ["res.json({ error: 'Update failed' })"],
    ["confirm('Delete from notes? Are you sure')"],
    ["log('insert into notes any time')"],
    ["q('SELECT * FROM notes WHERE id = $1')"],
    ['// UPDATE notes SET x = 1 (a comment)'],
  ])('ignores %s', (code) => {
    expect(writes(code)).toBe(0);
  });
});
