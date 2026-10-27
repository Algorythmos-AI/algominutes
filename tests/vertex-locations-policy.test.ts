import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Where Gemini may be asked is where users' transcripts and audio go. The Privacy Policy's processor table
// (apps/site/src/data/processing.json, rendered on /privacy) names Vertex AI's locations, so no environment may
// name a fallback location (VERTEX_FALLBACK_LOCATIONS, packages/ai/src/gemini-call.cjs) that the table doesn't.
const processing = JSON.parse(fs.readFileSync('apps/site/src/data/processing.json', 'utf8'));
const tfFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name.startsWith('.') ? [] : tfFiles(p);
    return p.endsWith('.tf') || p.endsWith('.tfvars') ? [p] : [];
  });

describe('Gemini fallback locations', () => {
  it('only ever name a location the Privacy Policy lists for Vertex AI', () => {
    const vertex = processing.processors.filter((p: any) => /vertex/i.test(p.id));
    expect(vertex.length).toBeGreaterThan(0);
    const listed = new Set(vertex.flatMap((p: any) => [p.region, ...(p.regions ?? [])]).filter(Boolean));

    const named: Array<{ file: string; loc: string }> = [];
    for (const file of tfFiles('infra/terraform')) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/VERTEX_FALLBACK_LOCATIONS\s*=\s*"([^"]*)"/g)) {
        for (const loc of m[1]!.split(',').map((s) => s.trim()).filter(Boolean)) named.push({ file, loc });
      }
    }
    for (const { file, loc } of named) expect(listed, `${file} names ${loc}`).toContain(loc);
  });
});
