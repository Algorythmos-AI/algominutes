import { describe, it, expect } from 'vitest';
import { meetLinkOf, notetakerAvailable, sendNotetaker } from './notetaker';
import { saveSession } from './session';
import { fakeStorage, fakeFetch, json, idTokenFor, type Call } from './testing';

function world(answer: (c: Call) => Response) {
  const storage = fakeStorage();
  const net = fakeFetch(answer);
  return { deps: { storage, fetch: net.fetch, now: () => 0 }, calls: net.calls };
}
const signIn = (w: ReturnType<typeof world>) => saveSession(w.deps, { idToken: idTokenFor('alice'), refreshToken: 'r', expiresIn: 3600 });

describe('meetLinkOf', () => {
  it('is a Meet meeting\'s own link, and nothing that only looks like one', () => {
    expect(meetLinkOf('https://meet.google.com/abc-defg-hij')).toBe('https://meet.google.com/abc-defg-hij');
    expect(meetLinkOf('https://meet.google.com/abc-defg-hij?authuser=1#x')).toBe('https://meet.google.com/abc-defg-hij');
    for (const url of ['https://meet.google.com/', 'https://meet.google.com/landing', 'http://meet.google.com/abc-defg-hij',
      'https://meet.google.com.evil.test/abc-defg-hij', 'https://evil.test/https://meet.google.com/abc-defg-hij', 'https://meet.google.com/abc-defg-hijk', undefined]) {
      expect(meetLinkOf(url)).toBeNull();
    }
  });
});

describe('whether the notetaker is offered', () => {
  it('only when /v1/config has both the bot and the extension on', async () => {
    for (const [notetaker, want] of [[{ bot: true, extension: true }, true], [{ bot: true, extension: false }, false], [{ bot: false, extension: true }, false], [undefined, false]] as const) {
      const w = world(() => json(200, { broadcastCapture: true, notetaker }));
      await signIn(w);
      expect(await notetakerAvailable(w.deps)).toBe(want);
      expect(w.calls[0]!.url).toBe('https://api.example.test/v1/config');
      expect(w.calls[0]!.headers.Authorization).toBe(`Bearer ${idTokenFor('alice')}`);
    }
  });

  it('signed out, or the api failing: not offered', async () => {
    const out = world(() => json(200, { notetaker: { bot: true, extension: true } }));
    expect(await notetakerAvailable(out.deps)).toBe(false);
    expect(out.calls).toHaveLength(0);
    const down = world(() => json(503, { notetaker: { bot: true, extension: true } }));
    await signIn(down);
    expect(await notetakerAvailable(down.deps)).toBe(false);
  });
});

describe('sending it', () => {
  it('sends the meeting\'s own link and the popup\'s request id', async () => {
    const w = world(() => json(200, { botId: 'b1', noteId: 'n1', status: 'requested' }));
    await signIn(w);
    expect(await sendNotetaker(w.deps, { url: 'https://meet.google.com/abc-defg-hij?authuser=1', requestId: 'req-12345678' })).toEqual({ ok: true, noteId: 'n1', already: false });
    expect(w.calls[0]!.url).toBe('https://api.example.test/v1/meetings/bots');
    expect(JSON.parse(w.calls[0]!.body!)).toEqual({ meetingUrl: 'https://meet.google.com/abc-defg-hij', requestId: 'req-12345678' });
    expect(w.calls[0]!.headers.Authorization).toBe(`Bearer ${idTokenFor('alice')}`);
  });

  it('one already on its way is that note', async () => {
    const w = world(() => json(409, { error: 'A notetaker is already on its way to this meeting.', noteId: 'n0' }));
    await signIn(w);
    expect(await sendNotetaker(w.deps, { url: 'https://meet.google.com/abc-defg-hij', requestId: 'req-12345678' })).toEqual({ ok: true, noteId: 'n0', already: true });
  });

  it('a refusal says the server\'s own sentence, or a plain one', async () => {
    const cases: Array<[Response, string]> = [
      [json(402, { error: 'quota_exceeded', message: 'You’ve used this month’s 600 notetaker minutes.' }), 'You’ve used this month’s 600 notetaker minutes.'],
      [json(402, {}), 'You’ve used this month’s notetaker minutes.'],
      [json(503, { error: 'The notetaker is off for now.' }), 'The notetaker is off for now.'],
      [json(426, { error: 'please_update' }), 'This version of the extension is out of date. Update it, then try again.'],
      [json(500, { error: 'internal' }), 'The notetaker couldn’t be sent. Try again.'],
      [new Response('<html>bad gateway</html>', { status: 502 }), 'The notetaker couldn’t be sent. Try again.'],
    ];
    for (const [res, message] of cases) {
      const w = world(() => res);
      await signIn(w);
      expect(await sendNotetaker(w.deps, { url: 'https://meet.google.com/abc-defg-hij', requestId: 'req-12345678' })).toEqual({ ok: false, message });
    }
  });

  it('not a Meet, or signed out: nothing is sent', async () => {
    const w = world(() => json(200, { noteId: 'n1' }));
    expect((await sendNotetaker(w.deps, { url: 'https://meet.google.com/abc-defg-hij', requestId: 'req-12345678' })).ok).toBe(false);
    await signIn(w);
    expect(await sendNotetaker(w.deps, { url: 'https://zoom.us/j/123', requestId: 'req-12345678' })).toEqual({ ok: false, message: 'Open the extension from a Google Meet meeting’s tab.' });
    expect(w.calls).toHaveLength(0);
  });
});
