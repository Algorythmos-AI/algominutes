import { describe, it, expect } from 'vitest';
import { AppConfigResponse, CreateMeetingBotRequest, Note } from '@algominutes/contracts/schemas';

// The notetaker contract (docs/plans/MEETINGS.md) must never break a build in
// the field: the web drops a note that fails Note, so every new field is
// optional and every enum-like value is an open string.
const baseNote = {
  id: 'n1', title: 'Weekly sync', workspaceId: 'workspace_u1', authorId: 'u1',
  status: 'recording', type: 'online_meeting', createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z',
};

describe('notetaker contract, forward compatible', () => {
  it('a note without notetaker fields still parses (every existing note)', () => {
    expect(Note.safeParse(baseNote).success).toBe(true);
  });

  it('a notetaker note uses only existing status and type values', () => {
    const parsed = Note.parse({ ...baseNote, sourceKind: 'bot', notetaker: { botId: 'b1', status: 'recording', platform: 'google_meet' } });
    expect(parsed.status).toBe('recording');
    expect(parsed.type).toBe('online_meeting');
  });

  it('values a client does not know yet still parse (open strings)', () => {
    const r = Note.safeParse({ ...baseNote, sourceKind: 'some_future_kind', notetaker: { botId: 'b1', status: 'a_new_state', failureReason: 'a_new_reason', platform: 'a_new_platform' } });
    expect(r.success).toBe(true);
  });

  it('a config answer from an older server (no notetaker) parses, and means off', () => {
    const r = AppConfigResponse.parse({ broadcastCapture: true });
    expect(r.notetaker).toBeUndefined();
  });

  it('a bot request needs a real URL and a client idempotency key', () => {
    expect(CreateMeetingBotRequest.safeParse({ meetingUrl: 'https://meet.google.com/abc-defg-hij', requestId: '6f1c2d3e-4b5a' }).success).toBe(true);
    expect(CreateMeetingBotRequest.safeParse({ meetingUrl: 'not a url', requestId: '6f1c2d3e-4b5a' }).success).toBe(false);
    expect(CreateMeetingBotRequest.safeParse({ meetingUrl: 'https://meet.google.com/abc-defg-hij' }).success).toBe(false);
  });
});
