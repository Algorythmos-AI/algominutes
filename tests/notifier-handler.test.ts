import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// The notifier's answers to Cloud Tasks and its token pruning
// (docs/plans/RELEASE.md PR 4, rev 9's S2-PR1).
const require = createRequire(import.meta.url);
const { handleNotify, isDeadTokenError } = require('../services/notifier/src/handler.js');

function harness(perToken: Array<{ success: true } | { success: false; code: string }>) {
  const lines: Array<[string, string, Record<string, unknown>]> = [];
  const at = (level: string) => (o: Record<string, unknown>, m: string) => { lines.push([level, m, o]); };
  const log: any = { info: at('info'), warn: at('warn'), error: at('error'), child: () => log };
  const deleted: string[] = [];
  const tokens = perToken.map((_, i) => ({ token: `tok-${i}` }));
  const deps = {
    log,
    traceIdFromTask: () => 'trace-n',
    tokensForUser: async () => tokens,
    deletePushToken: async (t: string) => { deleted.push(t); },
    claimNotice: async () => ({ claimed: true }),
    markNoticeSent: async () => {},
    releaseNotice: async () => {},
    messaging: () => ({
      sendEachForMulticast: async () => ({
        successCount: perToken.filter((r) => r.success).length,
        failureCount: perToken.filter((r) => !r.success).length,
        responses: perToken.map((r) => (r.success ? { success: true } : { success: false, error: { code: r.code } })),
      }),
    }),
  };
  return { deps, lines, deleted };
}
const task = { type: 'note_ready', noteId: 'n1', workspaceId: 'w1', uid: 'u1', noticeId: '42' };

describe('a malformed task', () => {
  it('is acknowledged (2xx) so Cloud Tasks stops retrying it, and logged as an error', async () => {
    for (const body of [{ ...task, type: 'nope' }, { ...task, noteId: undefined }, { ...task, uid: '' }, { ...task, noticeId: 'x' }, undefined]) {
      const { deps, lines } = harness([]);
      const out = await handleNotify(body, {}, deps);
      expect(out.status).toBeGreaterThanOrEqual(200);
      expect(out.status).toBeLessThan(300);
      expect(out.json).toEqual({ ok: false, error: 'bad_payload' });
      expect(lines.filter((l) => l[0] === 'error').map((l) => l[1])).toEqual(['notify_bad_payload']);
    }
  });
});

describe('token pruning', () => {
  it('prunes only a token FCM says is dead: unregistered, or not a token at all', async () => {
    const { deps, deleted, lines } = harness([
      { success: true },
      { success: false, code: 'messaging/registration-token-not-registered' },
      { success: false, code: 'messaging/invalid-registration-token' },
      { success: false, code: 'messaging/invalid-argument' },
      { success: false, code: 'messaging/internal-error' },
      { success: false, code: 'messaging/mismatched-credential' },
    ]);
    const out = await handleNotify(task, {}, deps);
    expect(out).toMatchObject({ status: 200, json: { ok: true, sent: 1, failed: 5, pruned: 2 } });
    expect(deleted).toEqual(['tok-1', 'tok-2']);
    // The others are kept and logged with their code.
    expect(lines.filter((l) => l[1] === 'notify_token_send_error').map((l) => l[2].code)).toEqual([
      'messaging/invalid-argument', 'messaging/internal-error', 'messaging/mismatched-credential',
    ]);
  });

  it("an invalid MESSAGE (FCM's invalid-argument) never deletes the recipients' tokens", () => {
    expect(isDeadTokenError({ code: 'messaging/invalid-argument' })).toBe(false);
    expect(isDeadTokenError({ code: 'messaging/registration-token-not-registered' })).toBe(true);
    expect(isDeadTokenError({ code: 'messaging/invalid-registration-token' })).toBe(true);
    expect(isDeadTokenError(null)).toBe(false);
  });
});
