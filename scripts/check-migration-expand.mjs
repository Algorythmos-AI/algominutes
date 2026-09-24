#!/usr/bin/env node
/**
 * check-migration-expand.mjs: new migrations must be expand-only, or say why
 * they're safe.
 *
 * Deploys apply migrations BEFORE rolling out new service images
 * (deploy-staging.yml: build → migrate → rollout). For that window the OLD
 * images serve traffic against the NEW schema, and after an image rollback
 * they do so for as long as the rollback lasts. That is safe for expand DDL: a
 * new table, a nullable or defaulted column, a plain index. It is not safe for
 * contract or tightening DDL, which can break the code that is serving:
 *   - DROP;
 *   - RENAME;
 *   - SET NOT NULL;
 *   - a column type change;
 *   - a NOT NULL column without a DEFAULT;
 *   - a new constraint or unique index on an existing table.
 *
 * BUILD-PLAN §4.4 (expand/contract): the contract step lands in a LATER
 * release, once the code that stopped depending on the old shape is live
 * everywhere. A migration that does it must carry a marker saying why the
 * serving code is compatible:
 *
 *   -- contract: no code reads shares.token since #41 (live on staging + prod)
 *
 * Only migrations ADDED relative to the PR base are gated; committed ones are
 * immutable (scripts/check-migrations.sh). `--all` reports on every migration.
 *
 *   node scripts/check-migration-expand.mjs [--all]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MIGRATIONS_DIR = 'packages/db/migrations';
const MIGRATION_FILE = /^\d{3}_[\w.-]+\.sql$/;
const IDENT = String.raw`(?:"[^"]+"|[\w.]+)`;

/** Strip comments and single-quoted literals, normalize case and whitespace. */
function normalize(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

/** Each `ADD [COLUMN] [IF NOT EXISTS] …` clause, up to the next comma. */
function addColumnClauses(stmt) {
  return [...stmt.matchAll(/\bADD\s+(?!CONSTRAINT\b|VALUE\b)(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?[^,]*/g)].map((m) => m[0]);
}

const RULES = [
  {
    id: 'drop',
    why: 'drops something the serving code may still use',
    hit: (s) => /\bDROP\b(?!\s+NOT\s+NULL\b)/.test(s),
  },
  { id: 'rename', why: 'renames something the serving code refers to by name', hit: (s) => /\bRENAME\b/.test(s) },
  { id: 'set-not-null', why: 'rejects NULL writes the serving code may still make', hit: (s) => /\bSET\s+NOT\s+NULL\b/.test(s) },
  {
    id: 'type-change',
    why: 'changes a column type under the serving code',
    hit: (s) => new RegExp(String.raw`\bALTER\s+(?:COLUMN\s+)?${IDENT}\s+(?:SET\s+DATA\s+)?TYPE\b`).test(s),
  },
  {
    id: 'not-null-without-default',
    why: 'inserts from the serving code omit the new column and fail',
    hit: (s) => addColumnClauses(s).some((c) => /\bNOT\s+NULL\b/.test(c) && !/\bDEFAULT\b/.test(c)),
  },
  {
    id: 'add-constraint',
    why: 'a new constraint on an existing table can reject writes the serving code makes',
    hit: (s, created) => {
      const m = s.match(new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${IDENT})[^;]*\bADD\s+CONSTRAINT\b`));
      return Boolean(m && !created.has(m[1]));
    },
  },
  {
    id: 'unique-index',
    why: 'a unique index on an existing table can reject writes the serving code makes',
    hit: (s, created) => {
      const m = s.match(new RegExp(String.raw`\bCREATE\s+UNIQUE\s+INDEX\b[^;]*?\bON\s+(?:ONLY\s+)?(${IDENT})`));
      return Boolean(m && !created.has(m[1]));
    },
  },
];

/** Contract/tightening findings in a migration's SQL: [{ rule, why, statement }]. */
export function classify(sql) {
  const norm = normalize(sql);
  const created = new Set(
    [...norm.matchAll(new RegExp(String.raw`\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})`, 'g'))].map((m) => m[1]),
  );
  const findings = [];
  for (const raw of norm.split(';')) {
    const statement = raw.trim();
    if (!statement) continue;
    for (const rule of RULES) {
      if (rule.hit(statement, created)) findings.push({ rule: rule.id, why: rule.why, statement: statement.slice(0, 120) });
    }
  }
  return findings;
}

/** A `-- contract: <reason>` line: the author's statement that the serving code is compatible. */
export function hasContractMarker(sql) {
  return /^[ \t]*--[ \t]*contract:[ \t]*\S/im.test(sql);
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf-8' }).trim();
}

function newMigrations() {
  const base = process.env.MIGRATION_BASE_REF || `origin/${process.env.GITHUB_BASE_REF || 'integration'}`;
  try {
    git(['rev-parse', '--verify', '--quiet', base]);
  } catch {
    if (process.env.GITHUB_ACTIONS) {
      console.error(`  FAIL  base ${base} not available (fetch-depth: 0?); cannot tell which migrations are new`);
      process.exit(1);
    }
    console.log(`  skip  ${base} not available locally; checking uncommitted migrations only`);
    return untracked();
  }
  const added = git(['diff', '--name-only', '--diff-filter=A', `${base}...HEAD`, '--', MIGRATIONS_DIR]);
  return [...new Set([...added.split('\n'), ...untracked()])].filter((f) => f && MIGRATION_FILE.test(path.basename(f)));
}

function untracked() {
  return git(['ls-files', '--others', '--exclude-standard', '--', MIGRATIONS_DIR])
    .split('\n')
    .filter((f) => f && MIGRATION_FILE.test(path.basename(f)));
}

function main() {
  const all = process.argv.includes('--all');
  const files = all
    ? fs.readdirSync(MIGRATIONS_DIR).filter((f) => MIGRATION_FILE.test(f)).sort().map((f) => path.join(MIGRATIONS_DIR, f))
    : newMigrations();

  console.log(`Migration expand-only gate (${all ? 'all migrations, report only' : 'new migrations'})\n`);
  if (!files.length) {
    console.log('  ok    no new migrations');
    return;
  }
  let fail = 0;
  for (const file of files) {
    const sql = fs.readFileSync(file, 'utf-8');
    const findings = classify(sql);
    const name = path.basename(file);
    if (!findings.length) {
      console.log(`  ok    ${name}: expand-only`);
    } else if (hasContractMarker(sql)) {
      console.log(`  ok    ${name}: contract step, marked (${findings.map((f) => f.rule).join(', ')})`);
    } else {
      console.log(`  ${all ? 'note' : 'FAIL'}  ${name}:`);
      for (const f of findings) console.log(`        [${f.rule}] ${f.why}\n          ${f.statement}`);
      if (!all) fail = 1;
    }
  }
  if (fail) {
    console.log(`
  Deploys run migrations BEFORE the new images roll out, so the code serving
  right now must keep working against this schema. Either make it expand-only
  (add, backfill, switch the code, and contract in a later release, per
  BUILD-PLAN §4.4), or, if the serving code no longer depends on what this
  changes, add a line saying why:

    -- contract: <why the code currently serving is compatible>`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
