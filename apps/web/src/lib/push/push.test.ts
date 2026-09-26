import { describe, expect, it, vi } from 'vitest';
import { fakeAuth, PERMANENT } from '../../test/fakeAuth';
import { fakePush } from '../../test/fakePush';
import { activated, firebaseMessaging, withPushSignOut } from './messaging';
import { inApp, noteIdOf, noteUrl, parsePush, pickWindow, workerMessage } from './noteLink';

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

describe("the worker's choices", () => {
  const scope = 'https://staging.algominutes.algorythmos.com/app/';
  const win = (url: string, focused = false, visibilityState: DocumentVisibilityState = 'hidden') => ({ url, focused, visibilityState });

  it("counts only the app's own windows, the notes list at /app included, never the public site", () => {
    expect(inApp(`${scope}notes/n1`, scope)).toBe(true);
    expect(inApp('https://staging.algominutes.algorythmos.com/app', scope)).toBe(true);
    expect(inApp('https://staging.algominutes.algorythmos.com/app?x=1', scope)).toBe(true);
    expect(inApp('https://staging.algominutes.algorythmos.com/privacy', scope)).toBe(false);
    expect(inApp('https://staging.algominutes.algorythmos.com/apple', scope)).toBe(false);
  });

  it('a tap goes to the window in front, else a visible one, else any app window', () => {
    const site = win('https://staging.algominutes.algorythmos.com/privacy', true, 'visible');
    const hidden = win(`${scope}record`);
    const visible = win('https://staging.algominutes.algorythmos.com/app', false, 'visible');
    const front = win(`${scope}notes/n2`, true, 'visible');
    expect(pickWindow([site, hidden, visible, front], scope)).toBe(front);
    expect(pickWindow([site, hidden, visible], scope)).toBe(visible);
    expect(pickWindow([site, hidden], scope)).toBe(hidden);
    expect(pickWindow([site], scope)).toBeNull();
  });

  it("reads the notifier's notification from FCM's payload, and leaves anything else to Firebase", () => {
    expect(parsePush({ notification: { title: 'Your note is ready', body: 'Weekly sync' }, data: { noteId: 'n1', type: 'ready' } })).toMatchObject({ title: 'Your note is ready', body: 'Weekly sync', noteId: 'n1' });
    expect(parsePush({ data: { noteId: 'n1' } })).toBeNull();
    expect(parsePush(null)).toBeNull();
    expect(parsePush('text')).toBeNull();
  });

  it("the app acts only on the worker's own two messages, with a checked note id", () => {
    expect(workerMessage({ type: 'algominutes:open-note', noteId: 'n1' })).toEqual({ type: 'algominutes:open-note', noteId: 'n1' });
    expect(workerMessage({ type: 'algominutes:open-note', noteId: '../x' })).toEqual({ type: 'algominutes:open-note', noteId: null });
    expect(workerMessage({ type: 'algominutes:push', title: 'T', body: 'B', noteId: 'n1' })).toEqual({ type: 'algominutes:push', title: 'T', body: 'B', noteId: 'n1' });
    expect(workerMessage({ type: 'something-else' })).toBeNull();
    expect(workerMessage({ isFirebaseMessaging: true })).toBeNull();
  });
});

describe('registering this browser', () => {
  const worker = (state: ServiceWorkerState) => Object.assign(new EventTarget(), { state });

  it('waits for the worker to be active before subscribing (a worker still installing makes it fail)', async () => {
    const sw = worker('installing');
    let done = false;
    const p = activated({ active: null, installing: sw, waiting: null } as unknown as ServiceWorkerRegistration).then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    sw.state = 'activated';
    sw.dispatchEvent(new Event('statechange'));
    await p;
    expect(done).toBe(true);
    await expect(activated({ active: {} } as unknown as ServiceWorkerRegistration)).resolves.toBeUndefined();
  });

  it('gives up on a worker that is replaced before it activates', async () => {
    const sw = worker('installing');
    const p = activated({ active: null, installing: sw, waiting: null } as unknown as ServiceWorkerRegistration);
    sw.state = 'redundant';
    sw.dispatchEvent(new Event('statechange'));
    await expect(p).rejects.toThrow(/replaced/);
  });
});

describe("the worker's messages to this window", () => {
  it('a push in view becomes a foreground message; a tap asks to open its note', () => {
    const container = new EventTarget();
    Object.defineProperty(navigator, 'serviceWorker', { value: container, configurable: true });
    try {
      const m = firebaseMessaging('vapid', () => ({}) as never)!;
      const fg = vi.fn();
      const open = vi.fn();
      const offFg = m.onForeground(fg);
      m.onOpenNote(open);
      container.dispatchEvent(new MessageEvent('message', { data: { type: 'algominutes:push', title: 'Ready', body: 'Weekly', noteId: 'n1' } }));
      container.dispatchEvent(new MessageEvent('message', { data: { type: 'algominutes:open-note', noteId: 'n2' } }));
      container.dispatchEvent(new MessageEvent('message', { data: { isFirebaseMessaging: true } }));
      expect(fg).toHaveBeenCalledWith({ noteId: 'n1', title: 'Ready', body: 'Weekly' });
      expect(open).toHaveBeenCalledWith('n2');
      offFg();
      container.dispatchEvent(new MessageEvent('message', { data: { type: 'algominutes:push', title: 'Again', body: '', noteId: null } }));
      expect(fg).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(navigator, 'serviceWorker');
    }
  });
});

