import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Plan rev 12 S11: yt-dlp was installed unpinned in the transcoder and extractor images, so every build took
// whatever PyPI had that minute (and a compromised release would have reached production on the next deploy).
// Every pip install in a service image names an exact version.
const dockerfiles = fs.readdirSync('services')
  .map((s) => path.join('services', s, 'Dockerfile'))
  .filter((f) => fs.existsSync(f));

describe('service images', () => {
  it('are found', () => {
    expect(dockerfiles.length).toBeGreaterThanOrEqual(8);
  });

  it.each(dockerfiles)('%s pins every pip package to an exact version', (file) => {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/pip3? install([^\n\\]*(?:\\\n[^\n\\]*)*)/g)) {
      const pkgs = m[1].split(/\s+/).map((t) => t.replace(/^["']|["']$/g, '')).filter((t) => t && !t.startsWith('-') && t !== '\\' && t !== '&&');
      for (const pkg of pkgs) expect(pkg, `${file}: ${pkg}`).toMatch(/==\d/);
    }
  });
});
