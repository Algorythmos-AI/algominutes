#!/usr/bin/env node
/**
 * check-migrations-applied.mjs — is production's schema actually current?
 *
 * `npm run db:migrate` is run by hand. Nothing verified it had been. So a push
 * to main could ship code that queries a column no migration had created:
 * functions/index.js on main already selects `shares.token_hash`, and if 006
 * had not been applied, shareCreate would have 500'd in production with nothing
 * anywhere reporting why.
 *
 * This is NOT a CI check, and cannot be — CI has no route to the private-IP
 * Cloud SQL instance, which is the reason migrations are manual. Run it from a
 * machine with database access (see docs/runbooks/bastion-psql.md), and run it
 * after any deploy that touches the schema.
 *
 *   DATABASE_URL=postgres://... node scripts/check-migrations-applied.mjs
 *
 * Exits non-zero when a migration on disk is missing from schema_migrations.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'packages', 'db', 'migrations');

if (!process.env.DATABASE_URL && !process.env.PGHOST) {
  console.error('Set DATABASE_URL (or PGHOST/PGUSER/PGPASSWORD) first.');
  console.error('See docs/runbooks/bastion-psql.md — 127.0.0.1, not localhost.');
  process.exit(2);
}

// Numbered migrations only. seed-*.sql and retire-*.sql are operator tools that
// are deliberately re-runnable and are not schema history.
const onDisk = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d{3}_.*\.sql$/.test(f))
  .sort();

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, max: 1 }
    : {
        host: process.env.PGHOST,
        port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
        database: process.env.PGDATABASE || 'postgres',
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD,
        max: 1,
      },
);

let applied;
try {
  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  applied = new Set(rows.map((r) => r.filename));
} catch (err) {
  console.error(`Could not read schema_migrations: ${err.message}`);
  console.error('If the table does not exist, no migration has ever run here.');
  await pool.end();
  process.exit(2);
}
await pool.end();

const missing = onDisk.filter((f) => !applied.has(f));
// A row with no file is not necessarily wrong — a migration could have been
// renamed — but it is worth seeing, because it usually means the opposite.
const orphaned = [...applied].filter((f) => /^\d{3}_/.test(f) && !onDisk.includes(f));

console.log(`  on disk:  ${onDisk.length}`);
console.log(`  applied:  ${applied.size}`);
for (const f of onDisk) {
  console.log(`    ${applied.has(f) ? 'ok  ' : 'MISS'}  ${f}`);
}

if (orphaned.length) {
  console.log('\n  Recorded as applied but not on disk (renamed? deleted?):');
  for (const f of orphaned) console.log(`    ${f}`);
}

if (missing.length) {
  console.error(`\nFAIL  ${missing.length} migration(s) never applied here.`);
  console.error('Run: DATABASE_URL=... npm run db:migrate');
  console.error('Code on main may already depend on the columns these create.');
  process.exit(1);
}

console.log('\nPASS  every migration on disk is recorded as applied.');
