import { describe, expect, it, vi } from 'vitest';
import { fakeAuth, PERMANENT } from '../../test/fakeAuth';
import { fakePush } from '../../test/fakePush';
import { withPushSignOut } from './messaging';
import { noteIdOf, noteUrl } from './noteLink';

vi.mock('../crashReport', () => ({ reportCrash: vi.fn() }));

describe('a tapped notification', () => {
  const scope = 'https://staging.algominutes.algorythmos.com/app/';

  it('opens its note in this environment, from our data or the FCM_MSG wrapper', () => {
    expect(noteUrl(scope, { noteId: 'n_1' })).toBe(`${scope}notes/n_1`);
    expect(noteUrl(scope, { FCM_MSG: { data: { noteId: 'abc-DEF_9', deepLink: 'algominutes://note/abc-DEF_9' } } })).toBe(`${scope}notes/abc-DEF_9`);
  });

  it('opens the notes list for anything that is not a plain note id', () => {
    for (const data of [null, undefined, {}, { noteId: 42 }, { noteId: '' }, { noteId: '../../evil' }, { noteId: 'https://evil.test/' }, { noteId: 'a?b' }, { noteId: 'x'.repeat(129) }]) {
      expect(noteIdOf(data), JSON.stringify(data)).toBeNull();
      expect(noteUrl(scope, data)).toBe(scope);
    }
  });
});

describe('sign-out', () => {
  it("forgets this browser's push token first, so the next person doesn't get the last one's notifications", async () => {
    const order: string[] = [];
    const { adapter } = fakeAuth(PERMANENT);
    adapter.signOut.mockImplementation(async () => void order.push('signOut'));
    const { messaging } = fakePush('granted');
    messaging.deleteToken = vi.fn(async () => void order.push('deleteToken'));
    await withPushSignOut(adapter, messaging).signOut();
    expect(order).toEqual(['deleteToken', 'signOut']);
  });

  it('still signs out when forgetting the token fails', async () => {
    const { adapter } = fakeAuth(PERMANENT);
    const { messaging } = fakePush('granted');
    messaging.deleteToken = vi.fn(async () => {
      throw new Error('offline');
    });
    await withPushSignOut(adapter, messaging).signOut();
    expect(adapter.signOut).toHaveBeenCalledOnce();
  });

  it('is the plain adapter when the build has no push', () => {
    const { adapter } = fakeAuth(PERMANENT);
    expect(withPushSignOut(adapter, null)).toBe(adapter);
  });
});
