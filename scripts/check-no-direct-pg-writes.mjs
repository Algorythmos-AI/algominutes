#!/usr/bin/env node
/**
 * CLAUDE.md §1: Postgres is the source of truth, "accessed only through the repo
 * layer in @algominutes/db", and "no service writes a table it does not own".
 * check-no-direct-firestore only sees Firestore, so nothing stopped a service
 * from writing tables with raw SQL (the transcoder did, until its SQL moved to
 * packages/db/src/pipeline-repo.cjs).
 *
 * This fails on any string, template or literal `+` chain outside packages/db
 * that writes a table (INSERT/UPDATE/DELETE/MERGE/TRUNCATE), including a
 * `${table}` interpolated after the keyword. Syntax-aware (the TypeScript
 * parser), so comments don't count, and the table must be followed by SQL, so
 * prose doesn't either.
 *
 *   node scripts/check-no-direct-pg-writes.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const ROOTS = ['services', 'packages', 'apps/web/src', 'scripts'];
// packages/db IS the repo layer. Tests, fixtures and the migrator are not services.
const SKIP = /(^|\/)(node_modules|dist|build|generated|migrations|test|tests)(\/|$)|^packages\/db\/|\.test\.[cm]?[jt]sx?$|\.d\.ts$/;
// Any table: no service writes Postgres except through the repo layer. The table
// may be ONLY-, schema- or quote-qualified, and must be followed by SQL (so prose
// like "failed to update notes" doesn't count).
const T = String.raw`(?:ONLY\s+)?(?:"?[A-Za-z_]\w*"?\.)?"?[A-Za-z_]\w*"?`;
const ALIAS = String.raw`(?:\s+(?:AS\s+)?(?!SET\b|WHERE\b|USING\b|RETURNING\b)[A-Za-z_]\w*)?`;
const WRITE = new RegExp([
  String.raw`\bINSERT\s+INTO\s+${T}\s*(?:\(|VALUES\b|SELECT\b|DEFAULT\b)`,
  String.raw`\bUPDATE\s+${T}${ALIAS}\s+SET\b`,
  String.raw`\bDELETE\s+FROM\s+${T}${ALIAS}\s*(?:WHERE\b|USING\b|RETURNING\b|;|$)`,
  String.raw`\bMERGE\s+INTO\s+${T}`,
  String.raw`\bTRUNCATE(?:\s+TABLE)?\s+${T}\s*(?:;|,|$|CASCADE\b|RESTART\b)`,
].join('|'), 'i');
// A write whose table name is interpolated: `UPDATE ${table} SET ...`.
const DYNAMIC = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?)\s*$/i;

function* sourceFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (SKIP.test(p)) continue;
    if (fs.statSync(p).isDirectory()) yield* sourceFiles(p);
    else if (/\.(c|m)?[jt]sx?$/.test(name)) yield p;
  }
}

/** The text of a string-literal `+` chain, or null if any operand isn't a literal. */
function concatenated(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return concatenated(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = concatenated(node.left);
    const r = l === null ? null : concatenated(node.right);
    return r === null ? null : l + r;
  }
  return null;
}

export function findDirectWrites(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out = [];
  const hit = (node, sql) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push({ file, line: line + 1, sql });
  };
  const visit = (node) => {
    // A literal + literal chain is checked whole, once.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const joined = concatenated(node);
      if (joined !== null) {
        const m = WRITE.exec(joined);
        if (m) hit(node, m[0].replace(/\s+/g, ' ').trim());
        return;
      }
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const m = WRITE.exec(node.text);
      if (m) hit(node, m[0].replace(/\s+/g, ' ').trim());
    } else if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text, ...node.templateSpans.map((sp) => sp.literal.text)];
      const m = WRITE.exec(parts.join(' '));
      if (m) hit(node, m[0].replace(/\s+/g, ' ').trim());
      else if (parts.slice(0, -1).some((p) => DYNAMIC.test(p))) hit(node, 'write to an interpolated table');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const hits = [];
  let files = 0;
  for (const root of ROOTS) {
    for (const f of sourceFiles(root)) {
      files += 1;
      hits.push(...findDirectWrites(f, fs.readFileSync(f, 'utf8')));
    }
  }
  let failed = false;
  if (files === 0) {
    console.log('ERROR: scanned no files (run from the repo root).');
    failed = true;
  }
  if (hits.length) {
    for (const h of hits) console.log(`${h.file}:${h.line}: ${h.sql} outside the repo layer`);
    console.log(`\nERROR: ${hits.length} Postgres write(s) outside packages/db. Put the SQL in the`);
    console.log('repo layer (@algominutes/db) and call it (CLAUDE.md §1).');
    failed = true;
  }
  if (failed) process.exit(1);
  console.log(`OK: no Postgres writes outside the repo layer (${files} files).`);
}
