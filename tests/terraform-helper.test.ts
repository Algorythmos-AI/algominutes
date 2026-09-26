import { describe, it, expect } from 'vitest';
import { entries, mergeParts, stripComments } from './helpers/terraform';

// The contract tests read Terraform with this helper, so a misread is a false
// pass. These pin the shapes it must get right.
describe('entries', () => {
  it('reads a whole ternary as one value, never its branches as entries', () => {
    const got = entries('a = contains(local.x, each.key) ? { K = "v" } : {}\nb = "y"\n');
    expect(got).toEqual({ a: 'contains(local.x, each.key) ? { K = "v" } : {}', b: '"y"' });
  });

  it('reads a multi-line merge as one value', () => {
    const got = entries('api = merge(local.db_env, {\n  X = "1"\n  Y = var.y\n})\nnext = local.db_env\n');
    expect(Object.keys(got)).toEqual(['api', 'next']);
    expect(mergeParts(got.api)).toEqual(['local.db_env', '{\n  X = "1"\n  Y = var.y\n}']);
  });

  it('ignores comments but keeps # and // inside strings', () => {
    expect(stripComments('A = "https://x#y" # note\n// gone\nB = 1')).toBe('A = "https://x#y" \n\nB = 1');
    expect(entries('A = "https://x#y" # note\nB = 1')).toEqual({ A: '"https://x#y"', B: '1' });
  });

  it("doesn't read a comparison as an entry", () => {
    expect(entries('ok = var.a == "b"\n')).toEqual({ ok: 'var.a == "b"' });
  });
});
