import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { NoteDoc } from '../../lib/notes/notesFeed';
import { fakeAuth, PERMANENT } from '../../test/fakeAuth';
import { fakePush } from '../../test/fakePush';
import { fakeFeed, renderApp } from '../../test/renderApp';

vi.mock('../../lib/crashReport', () => ({ reportCrash: vi.fn() }));

const note = (id: string): NoteDoc => ({
  id,
  title: `Note ${id}`,
  workspaceId: 'workspace_u1',
  authorId: 'u1',
  status: 'processing',
  type: 'recording',
  createdAt: '2026-09-26T01:00:00.000Z',
  updatedAt: new Date().toISOString(),
  duration: 60,
  storagePath: `recordings/workspace_u1/${id}.m4a`,
});

const registers: Array<Record<string, unknown>> = [];
const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(url)).pathname;
  if (path === '/v1/push/register') registers.push(JSON.parse(String(init?.body)));
  if (path === '/v1/entitlement') return new Response(JSON.stringify({ state: 'active', plan: 'free', billingPeriod: '2026-09', includedMinutes: 60, usedMinutes: 0, remainingMinutes: 60, overQuota: false }), { status: 200 });
  return new Response('{"ok":true}', { status: 200 });
}) as typeof fetch;

afterEach(() => {
  cleanup();
  localStorage.clear();
  registers.length = 0;
});

const PROMPT = /Know when a note is ready\?/;

describe('push notifications', () => {
  it('asks only once the user has a note, and only from their click; then registers this browser', async () => {
    const { messaging } = fakePush('default', 'granted');
    const feed = fakeFeed([]);
    renderApp('/app', fakeAuth(PERMANENT).adapter, fetchImpl, feed.feed, null, messaging);
    await screen.findByRole('heading', { name: /notes/i });
    expect(screen.queryByText(PROMPT)).toBeNull();

    feed.push([note('n1')]);
    expect(await screen.findByText(PROMPT)).toBeTruthy();
    expect(messaging.requestPermission).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Turn on notifications' }));
    await waitFor(() => expect(registers).toEqual([{ token: 'fcm-token-1', platform: 'web', appVersion: expect.any(String) }]));
    expect(messaging.requestPermission).toHaveBeenCalledOnce();
    expect(screen.queryByText(PROMPT)).toBeNull();
  });

  it('"Not now" hides the card for good, and never asks the browser', async () => {
    const { messaging } = fakePush('default');
    renderApp('/app', fakeAuth(PERMANENT).adapter, fetchImpl, fakeFeed([note('n1')]).feed, null, messaging);
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(screen.queryByText(PROMPT)).toBeNull();
    cleanup();
    renderApp('/app', fakeAuth(PERMANENT).adapter, fetchImpl, fakeFeed([note('n1')]).feed, null, messaging);
    await screen.findByRole('heading', { name: /notes/i });
    expect(screen.queryByText(PROMPT)).toBeNull();
    expect(messaging.requestPermission).not.toHaveBeenCalled();
  });

  it('with permission already given, registers on load for whoever is signed in, and shows no card', async () => {
    const { messaging } = fakePush('granted');
    renderApp('/app', fakeAuth(PERMANENT).adapter, fetchImpl, fakeFeed([note('n1')]).feed, null, messaging);
    await waitFor(() => expect(registers).toHaveLength(1));
    expect(screen.queryByText(PROMPT)).toBeNull();
  });

  it('registers again for the next user of the browser (the api re-homes the token)', async () => {
    const { messaging } = fakePush('granted');
    const auth = fakeAuth(PERMANENT);
    renderApp('/app', auth.adapter, fetchImpl, fakeFeed([]).feed, null, messaging);
    await waitFor(() => expect(registers).toHaveLength(1));
    auth.set({ ...PERMANENT, uid: 'u2' });
    await waitFor(() => expect(registers).toHaveLength(2));
  });

  it("a push while the app is in front shows as a notice (FCM shows nothing then)", async () => {
    const push = fakePush('granted');
    renderApp('/app', fakeAuth(PERMANENT).adapter, fetchImpl, fakeFeed([]).feed, null, push.messaging);
    await waitFor(() => expect(push.messaging.onForeground).toHaveBeenCalled());
    push.deliver({ noteId: 'n1', title: 'Your note is ready', body: 'Weekly sync' });
    expect(await screen.findByText('Your note is ready: Weekly sync')).toBeTruthy();
  });

  it('a refusal says how to undo it', async () => {
    const { messaging } = fakePush('default', 'denied');
    renderApp('/app', fakeAuth(PERMANENT).adapter, fetchImpl, fakeFeed([note('n1')]).feed, null, messaging);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on notifications' }));
    expect(await screen.findByText(/blocked for this site/)).toBeTruthy();
    expect(registers).toEqual([]);
  });

  it('Settings shows the state, and can turn them on after "Not now"', async () => {
    localStorage.setItem('algominutes.pushPrompt.dismissed', '1');
    const { messaging } = fakePush('default', 'granted');
    renderApp('/app/settings', fakeAuth(PERMANENT).adapter, fetchImpl, fakeFeed([]).feed, null, messaging);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on notifications' }));
    expect(await screen.findByText(/^On\. This browser is told/)).toBeTruthy();
    await waitFor(() => expect(registers).toHaveLength(1));
  });

  it('without a VAPID key there is no push at all: no card, no Settings section', async () => {
    renderApp('/app/settings', fakeAuth(PERMANENT).adapter, fetchImpl, fakeFeed([note('n1')]).feed, null, null);
    await screen.findByRole('heading', { name: 'Settings' });
    expect(screen.queryByText(PROMPT)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Notifications' })).toBeNull();
  });
});
