#!/usr/bin/env node
/**
 * CLAUDE.md §1: Postgres is the source of truth, "accessed only through the repo
 * layer in @algominutes/db", and "no service writes a table it does not own".
 * check-no-direct-firestore only sees Firestore, so nothing stopped a service
 * from writing note tables with raw SQL (the transcoder did, until its SQL
 * moved to packages/db/src/pipeline-repo.cjs).
 *
 * This fails on any string or template literal outside packages/db that
 * INSERTs into, UPDATEs or DELETEs FROM a note table. Syntax-aware (the
 * TypeScript parser), so comments and prose don't count.
 *
 *   node scripts/check-no-direct-pg-writes.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOTS = ['services', 'packages', 'apps/web/src', 'scripts'];
// packages/db IS the repo layer. Tests, fixtures and the migrator are not services.
const SKIP = /(^|\/)(node_modules|dist|build|generated|migrations|test|tests)(\/|$)|^packages\/db\/|\.test\.[cm]?[jt]sx?$|\.d\.ts$/;
const TABLES = [
  'notes', 'summaries', 'action_items', 'key_decisions', 'transcript_lines',
  'audio_chunks', 'embeddings', 'note_speakers',
];
const WRITE = new RegExp(String.raw`\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(${TABLES.join('|')})\b`, 'i');

// Shared packages/ai writers still to move into packages/db (BLOCKERS: "Postgres
// note writes still bypass the repo layer"). Shrink this list; never grow it.
const PENDING_MOVE = new Set([
  'packages/ai/src/note-terminal.cjs',
  'packages/ai/src/note-edit.cjs',
  'packages/ai/src/embeddings.cjs',
]);

function* sourceFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (SKIP.test(p)) continue;
    if (fs.statSync(p).isDirectory()) yield* sourceFiles(p);
    else if (/\.(c|m)?[jt]sx?$/.test(name)) yield p;
  }
}

export function findDirectWrites(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out = [];
  const visit = (node) => {
    let literal = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literal = node.text;
    else if (ts.isTemplateExpression(node)) literal = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ');
    const m = literal && WRITE.exec(literal);
    if (m) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      out.push({ file, line: line + 1, sql: `${m[1].toUpperCase()} ${m[2]}` });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const hits = [];
  const stale = new Set(PENDING_MOVE);
  let files = 0;
  for (const root of ROOTS) {
    for (const f of sourceFiles(root)) {
      files += 1;
      const found = findDirectWrites(f, fs.readFileSync(f, 'utf8'));
      if (PENDING_MOVE.has(f)) {
        if (found.length) stale.delete(f);
        continue;
      }
      hits.push(...found);
    }
  }
  let failed = false;
  if (hits.length) {
    for (const h of hits) console.log(`${h.file}:${h.line}: ${h.sql} outside the repo layer`);
    console.log(`\nERROR: ${hits.length} Postgres note-table write(s) outside packages/db. Put the SQL in the`);
    console.log('repo layer (@algominutes/db) and call it (CLAUDE.md §1).');
    failed = true;
  }
  if (stale.size) {
    console.log(`\nERROR: remove from PENDING_MOVE (no longer writes, or moved): ${[...stale].join(', ')}`);
    failed = true;
  }
  if (failed) process.exit(1);
  console.log(`OK: no Postgres note-table writes outside the repo layer (${files} files; ${PENDING_MOVE.size} pending move).`);
}
