import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { hashInviteCode, normaliseInviteCode } from '@algominutes/db';

// scripts/new-invite-code.sh makes a beta invite code on the owner's machine and
// prints the code (for the tester) and its hash (the only thing the db-job
// gets). The hash must be exactly what the server computes when a tester
// redeems, or no one could ever use the code.
describe('scripts/new-invite-code.sh', () => {
  const run = () => execFileSync('bash', ['scripts/new-invite-code.sh'], { encoding: 'utf8' });

  it("prints a canonical code and the server's hash of it, and a command carrying only the hash", () => {
    for (let i = 0; i < 20; i++) {
      const out = run();
      const code = out.match(/\bBETA-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}\b/)![0];
      const hash = out.match(/INVITE_CODE_SHA256=([0-9a-f]{64})/)![1];
      expect(normaliseInviteCode(code)).toBe(code);
      expect(hash).toBe(hashInviteCode(code));
      const command = out.slice(out.indexOf('gcloud'));
      expect(command).not.toContain(code);
    }
  });

  it('makes a different code every time', () => {
    const codes = new Set(Array.from({ length: 50 }, () => run().match(/BETA-[0-9A-Z-]{17}/)![0]));
    expect(codes.size).toBe(50);
  });
});
