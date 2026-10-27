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

type Source = { file: string; text: string };

/**
 * Every fallback location Terraform can set, wherever it's set: the env var itself, a module argument or tfvars
 * entry named vertex_fallback_locations, or that variable's default. A value this can't read (anything but a
 * quoted string, or a pass-through of var.vertex_fallback_locations, whose own values are read where they're set)
 * is returned as unchecked, and fails: the check never passes by not looking.
 */
function fallbackSettings(sources: Source[]) {
  const named: Array<{ file: string; loc: string }> = [];
  const unchecked: Array<{ file: string; value: string }> = [];
  const take = (file: string, value: string) => {
    const literal = /^"([^"]*)"/.exec(value);
    if (literal) {
      for (const loc of literal[1]!.split(',').map((s) => s.trim()).filter(Boolean)) named.push({ file, loc });
    } else if (!/^var\.vertex_fallback_locations\b/i.test(value)) {
      unchecked.push({ file, value });
    }
  };
  for (const { file, text } of sources) {
    for (const m of text.matchAll(/\bvertex_fallback_locations\s*=\s*([^\n]+)/gi)) take(file, m[1]!.trim());
    for (const m of text.matchAll(/variable\s+"vertex_fallback_locations"\s*\{([\s\S]*?)\n\}/gi)) {
      const d = /\bdefault\s*=\s*([^\n]+)/.exec(m[1]!);
      if (d) take(file, d[1]!.trim());
    }
  }
  return { named, unchecked };
}

describe('Gemini fallback locations', () => {
  it('only ever name a location the Privacy Policy lists for Vertex AI', () => {
    const vertex = processing.processors.filter((p: any) => /vertex/i.test(p.id));
    expect(vertex.length).toBeGreaterThan(0);
    const listed = new Set(vertex.flatMap((p: any) => [p.region, ...(p.regions ?? [])]).filter(Boolean));

    const { named, unchecked } = fallbackSettings(tfFiles('infra/terraform').map((file) => ({ file, text: fs.readFileSync(file, 'utf8') })));
    expect(unchecked, 'a fallback setting this test cannot read').toEqual([]);
    for (const { file, loc } of named) expect(listed, `${file} names ${loc}`).toContain(loc);
  });

  it('reads the setting however Terraform spells it, and refuses what it cannot read', () => {
    const { named, unchecked } = fallbackSettings([
      { file: 'cloud-run.tf', text: 'VERTEX_FALLBACK_LOCATIONS = var.vertex_fallback_locations\n' },
      { file: 'variables.tf', text: 'variable "vertex_fallback_locations" {\n  type    = string\n  default = "global"\n}\n' },
      { file: 'envs/prod/main.tf', text: '  vertex_fallback_locations = "australia-southeast2, global"\n' },
      { file: 'other.tf', text: 'VERTEX_FALLBACK_LOCATIONS = local.where\n' },
    ]);
    expect(named.map((n) => `${n.file}:${n.loc}`)).toEqual([
      'variables.tf:global', 'envs/prod/main.tf:australia-southeast2', 'envs/prod/main.tf:global',
    ]);
    expect(unchecked).toEqual([{ file: 'other.tf', value: 'local.where' }]);
  });
});
