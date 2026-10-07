import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as S from '@algominutes/contracts/schemas';

// packages/contracts/fixtures: real-shaped /v1 bodies that the iOS app's own models decode too
// (ContractFixturesTests). Here, each must be exactly what its schema accepts: nothing refused, nothing
// dropped. So the fixtures can't drift from the contract, and iOS decodes what the server may send
// (RELEASE.md PR 30d, S2-PR9).
const DIR = path.resolve(__dirname, '../packages/contracts/fixtures/v1');
const SCHEMA_OF: Record<string, { parse: (v: unknown) => unknown } | Record<string, { parse: (v: unknown) => unknown }>> = {
  'entitlement.json': S.EntitlementResponse,
  'redeem-invite.json': S.RedeemInviteResponse,
  'verify-purchase.json': S.VerifyPurchaseResponse,
  'app-config.json': S.AppConfigResponse,
  'uploads.json': { session: S.CreateUploadSessionResponse, status: S.UploadSessionStatus, complete: S.CompleteUploadResponse },
  'retention.json': S.RetentionResponse,
  'search.json': S.SearchResponse,
  'note-page.json': S.NoteReadPageResponse,
};

describe('contract fixtures', () => {
  it('every fixture file has a schema, and every schema a file', () => {
    expect(fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()).toEqual(Object.keys(SCHEMA_OF).sort());
  });

  for (const [file, schema] of Object.entries(SCHEMA_OF)) {
    const cases = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')) as Record<string, unknown>;
    for (const [name, body] of Object.entries(cases)) {
      it(`${file} ${name}: the schema accepts it whole`, () => {
        const s = 'parse' in schema ? schema : (schema as Record<string, { parse: (v: unknown) => unknown }>)[name];
        expect(s, `no schema for ${file} ${name}`).toBeDefined();
        expect(s!.parse(body)).toEqual(body);
      });
    }
  }
});
