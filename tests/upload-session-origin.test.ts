import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { MODULE, stripComments, read, balanced } from './helpers/terraform';
// @ts-expect-error: plain ESM route module, no type declarations
import { sessionOrigin } from '../services/api/src/routes/uploads.js';

// The web app uploads a recording straight to its GCS resumable session. GCS
// answers that cross-origin PUT only if the session was created with the
// page's Origin and the bucket's CORS lists it.
describe('sessionOrigin', () => {
  const allowed = new Set(['https://algominutes.algorythmos.com', 'https://staging.algominutes.algorythmos.com', 'http://localhost:3000', 'capacitor://localhost']);

  it("binds the session to the site's origin", () => {
    expect(sessionOrigin('https://staging.algominutes.algorythmos.com', allowed)).toBe('https://staging.algominutes.algorythmos.com');
  });

  it('binds nothing for the native apps (no Origin), a local or capacitor origin, or one the api would refuse', () => {
    for (const o of [undefined, '', 'http://localhost:3000', 'capacitor://localhost', 'https://evil.example', ['https://algominutes.algorythmos.com']]) {
      expect(sessionOrigin(o, allowed), String(o)).toBeUndefined();
    }
  });
});

describe('the recordings bucket admits browser uploads from the site, and only there', () => {
  const main = stripComments(read(`${MODULE}/main.tf`));
  const bucket = balanced(main, main.indexOf('{', main.indexOf('resource "google_storage_bucket" "buckets"')));

  it('a CORS rule, on the recordings bucket only, for PUT, from the https api origins', () => {
    expect(bucket).toMatch(/dynamic "cors"\s*\{\s*for_each\s*=\s*\(each\.value == "recordings" && length\(local\.browser_upload_origins\) > 0\)/);
    expect(bucket).toMatch(/method\s*=\s*\["PUT"\]/);
    expect(bucket).toMatch(/origin\s*=\s*local\.browser_upload_origins/);
    expect(main).toMatch(/browser_upload_origins = \[for o in split\(",", var\.allowed_origins\) : trimspace\(o\) if startswith\(trimspace\(o\), "https:\/\/"\)\]/);
  });

  it("exposes the resumable protocol's Range header (the resume offset)", () => {
    expect(bucket).toMatch(/response_header\s*=\s*\[[^\]]*"Range"[^\]]*\]/);
  });

  it('the upload route passes the origin to GCS', () => {
    expect(fs.readFileSync('services/api/src/routes/uploads.js', 'utf8')).toMatch(/createResumableUpload\(\{\s*metadata: \{ contentType \},\s*\.\.\.\(origin \? \{ origin \} : \{\}\),/);
  });
});
