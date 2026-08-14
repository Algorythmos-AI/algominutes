// Emits openapi/openapi.v1.json from the zod schemas.
//
// Run via `npm run openapi` (tsx). This is the ONLY writer of that file — it is
// committed so the artifact exists without a build, but it is regenerated, not
// hand-edited. `npm run models` then feeds the JSON to openapi-generator-cli.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildOpenApiDocument } from '../src/openapi';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '../openapi/openapi.v1.json');

const doc = buildOpenApiDocument();
mkdirSync(dirname(outPath), { recursive: true });
// Trailing newline + 2-space indent so the committed diff is reviewable.
writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

// eslint-disable-next-line no-console -- a build script may report its output
console.log(`wrote ${outPath}`);
