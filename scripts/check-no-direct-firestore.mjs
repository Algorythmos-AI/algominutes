#!/usr/bin/env node
/**
 * check-no-direct-firestore.mjs: Postgres is the source of truth and Firestore
 * is a cache, so note documents are written only by the repo/mirror layer
 * (CLAUDE.md §1). This is a syntax-aware replacement for the old grep gate.
 *
 * The grep version matched only one-line idioms, so a write split across lines
 * (`db.doc(...)\n  .set(...)`) passed. That's how direct note writes survived in
 * regenerate-summary.js and process-audio.js. This one parses every file with
 * the TypeScript compiler and flags any `.set / .update / .delete / .create`
 * call that writes a document, however it is formatted:
 *   - the receiver is a `.doc(...)` result, a ref variable (`ref`, `*Ref`) or a
 *     `.ref` property (`snap.ref.update(...)`);
 *   - or the FIRST ARGUMENT is one of those, which is how batched,
 *     transactional and bulk writes look (`batch.delete(db.doc(p))`,
 *     `tx.set(noteRef, ...)`).
 *
 * A write that is deliberately not a note write (a rate-limit counter, say)
 * carries `// firestore-write-ok: <reason>` on its line or the line above.
 *
 *   node scripts/check-no-direct-firestore.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOTS = ['functions', 'services', 'packages/db', 'packages/ai'];
const skip = (p) => /(^|\/)(node_modules|dist|build|generated)(\/|$)/.test(p) || p.endsWith('.d.ts');
const WRITES = new Set(['set', 'update', 'delete', 'create']);
const MARKER = /firestore-write-ok:[ \t]*[^\s*]/;

// The only files allowed to write Firestore documents, each with its reason.
export const ALLOWLIST = new Map([
  ['packages/db/src/notes-repo.ts', 'the repo layer: Postgres first, then the Firestore mirror'],
  ['packages/db/src/storage-purges-repo.ts', "the repo layer's deletion outbox: re-deletes a deleted note's mirror doc after Postgres"],
  ['packages/db/src/account-repo.ts', "the repo layer's account deletion: removes the account's own docs after Postgres"],
  ['packages/db/src/note-terminal.cjs', 'the repo layer: the terminal-failure writer, workspace-scoped Postgres, then the mirror'],
  ['services/transcoder/src/firestore-mirror.js', "the transcoder's mirror module"],
]);

function* sourceFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (skip(p)) continue;
    if (fs.statSync(p).isDirectory()) yield* sourceFiles(p);
    else if (/\.(c|m)?[jt]s$/.test(name)) yield p;
  }
}

/** A document reference: `x.doc(...)`, a `ref` / `*Ref` variable, or `x.ref`. */
function isDocRef(node) {
  if (!node) return false;
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'doc') return true;
  if (ts.isIdentifier(node) && /(^ref|Ref)$/.test(node.text)) return true;
  return ts.isPropertyAccessExpression(node) && node.name.text === 'ref';
}

/** Direct document writes in one file: [{ line, snippet }]. */
export function findDirectWrites(file, source) {
  const kind = /\.tsx?$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const lines = source.split('\n');
  const out = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && WRITES.has(node.expression.name.text)
        && (isDocRef(node.expression.expression) || isDocRef(node.arguments[0]))) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      const marked = MARKER.test(lines[line] || '') || MARKER.test(lines[line - 1] || '');
      if (!marked) out.push({ line: line + 1, snippet: node.getText(sf).replace(/\s+/g, ' ').slice(0, 100) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const hits = [];
  let files = 0;
  for (const root of ROOTS) {
    for (const f of sourceFiles(root)) {
      files += 1;
      if (ALLOWLIST.has(f)) continue;
      for (const h of findDirectWrites(f, fs.readFileSync(f, 'utf8'))) hits.push(`${f}:${h.line}: ${h.snippet}`);
    }
  }
  if (hits.length) {
    hits.forEach((h) => console.log(h));
    console.log(`\nERROR: ${hits.length} direct Firestore document write(s) outside the repo/mirror layer.`);
    console.log('Route note writes through @algominutes/db (notes-repo). CLAUDE.md §1.');
    console.log('A write that is not a note write: mark it `// firestore-write-ok: <reason>`.');
    process.exit(1);
  }
  console.log(`OK: no direct Firestore document writes outside the repo/mirror layer (${files} files, syntax-aware).`);
}
