import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { fakeAuth, PERMANENT } from '../../test/fakeAuth';
import { fakeFeed, renderApp } from '../../test/renderApp';
import { meetLinkOf, NOTETAKER_AFFIRMATION } from './NotetakerPage';

// Sending the notetaker from a pasted Meet link (RELEASE.md PR 24; CONSENT.md §2.4). The create contract has no
// consent field, so this page is what enforces the affirmation: these tests pin that nothing is sent without it.
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const BOT = 'b0a1b2c3-0000-4000-8000-000000000001';
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const config = (bot: boolean) => ({ broadcastCapture: false, notetaker: { bot, calendar: false, zoomImport: false, extension: false } });

function server(opts: { bot?: boolean; create?: (body: Record<string, unknown>) => Response } = {}) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    calls.push({ url: u, body });
    if (u.endsWith('/v1/config')) return json(config(opts.bot ?? true));
    if (u.endsWith('/v1/meetings/bots')) return opts.create?.(body) ?? json({ botId: BOT, noteId: 'mtg_new', status: 'requested' });
    return json({ ok: true });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, creates: () => calls.filter((c) => c.url.endsWith('/v1/meetings/bots')) };
}

async function openPage(s: ReturnType<typeof server>) {
  renderApp('/app/notetaker', fakeAuth(PERMANENT).adapter, s.fetchImpl, fakeFeed([]).feed);
  await screen.findByRole('heading', { level: 1, name: 'Send the notetaker' });
}
const fill = (link: string) => fireEvent.change(screen.getByRole('textbox', { name: 'Meeting link' }), { target: { value: link } });
const tick = () => fireEvent.click(screen.getByRole('checkbox', { name: NOTETAKER_AFFIRMATION }));
const sendButton = () => screen.getByRole('button', { name: 'Send the notetaker' });

describe('sending the notetaker', () => {
  it('sends nothing until the link is a Meet link and the affirmation is ticked', async () => {
    const s = server();
    await openPage(s);
    expect(sendButton()).toHaveProperty('disabled', true);
    fill('https://zoom.us/j/123');
    expect(screen.getByText(/Paste a Google Meet link/)).toBeTruthy();
    fill('meet.google.com/abc-defg-hij');
    expect(sendButton()).toHaveProperty('disabled', true);
    fireEvent.submit(sendButton().closest('form')!);
    tick();
    expect(sendButton()).toHaveProperty('disabled', false);
    tick();
    fireEvent.submit(sendButton().closest('form')!);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.creates()).toEqual([]);
  });

  it('sends the link (made https) with a request id and the title, and opens the note to watch it', async () => {
    const s = server();
    await openPage(s);
    fill('meet.google.com/abc-defg-hij');
    fireEvent.change(screen.getByRole('textbox', { name: /Title/ }), { target: { value: ' Weekly sync ' } });
    tick();
    fireEvent.click(sendButton());
    await waitFor(() => expect(s.creates()).toHaveLength(1));
    expect(s.creates()[0].body).toEqual({ meetingUrl: 'https://meet.google.com/abc-defg-hij', title: 'Weekly sync', requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    // /notes/mtg_new: the note's doc hasn't arrived in this fake feed, so it isn't listed yet.
    expect(await screen.findByRole('heading', { name: "This note isn't available" })).toBeTruthy();
  });

  it('a retry of the same meeting sends the same request id; another meeting gets a new one', async () => {
    let n = 0;
    const s = server({ create: () => ((n += 1) === 1 ? json({ error: 'The notetaker is busy right now. Please try again in a few minutes.' }, 503) : json({ error: 'nope nope' }, 503)) });
    await openPage(s);
    fill('https://meet.google.com/abc-defg-hij');
    tick();
    fireEvent.click(sendButton());
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'The notetaker is busy right now. Please try again in a few minutes.');
    fireEvent.click(sendButton());
    await waitFor(() => expect(s.creates()).toHaveLength(2));
    fill('https://meet.google.com/xyz-abcd-efg');
    fireEvent.click(sendButton());
    await waitFor(() => expect(s.creates()).toHaveLength(3));
    const ids = s.creates().map((c) => c.body.requestId);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it('a notetaker already on its way to this meeting opens that note', async () => {
    const s = server({ create: () => json({ error: 'A notetaker is already on its way to this meeting.', botId: BOT, noteId: 'mtg_old' }, 409) });
    await openPage(s);
    fill('https://meet.google.com/abc-defg-hij');
    tick();
    fireEvent.click(sendButton());
    expect(await screen.findByRole('heading', { name: "This note isn't available" })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says why when it can\'t: out of notetaker minutes, a link the server refuses, no connection', async () => {
    for (const [answer, text] of [
      [() => json({ error: 'quota_exceeded', message: "You've used this month's notetaker minutes." }, 402), "You've used this month's notetaker minutes."],
      [() => json({ error: 'The notetaker joins Google Meet meetings for now.' }, 400), 'The notetaker joins Google Meet meetings for now.'],
      // The api client's own words for no connection.
      [() => { throw new TypeError('offline'); }, "Can't reach AlgoMinutes. Check your connection."],
    ] as const) {
      const s = server({ create: answer as () => Response });
      await openPage(s);
      fill('https://meet.google.com/abc-defg-hij');
      tick();
      fireEvent.click(sendButton());
      expect((await screen.findByRole('alert')).textContent).toBe(text);
      cleanup();
    }
  });

  it('while the server has it off for this user, there is nothing to send, and the notes list doesn\'t offer it', async () => {
    const s = server({ bot: false });
    renderApp('/app/notetaker', fakeAuth(PERMANENT).adapter, s.fetchImpl, fakeFeed([]).feed);
    expect(await screen.findByText(/isn’t available to you yet/)).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    cleanup();
    renderApp('/app', fakeAuth(PERMANENT).adapter, s.fetchImpl, fakeFeed([]).feed);
    await screen.findByRole('heading', { level: 1, name: 'Your notes' });
    await waitFor(() => expect(s.calls.some((c) => c.url.endsWith('/v1/config'))).toBe(true));
    expect(screen.queryByRole('link', { name: 'Send the notetaker' })).toBeNull();
  });

  it('while it\'s on, the notes list offers it', async () => {
    renderApp('/app', fakeAuth(PERMANENT).adapter, server().fetchImpl, fakeFeed([]).feed);
    expect(await screen.findByRole('link', { name: 'Send the notetaker' })).toBeTruthy();
  });
});

describe('meetLinkOf', () => {
  it('takes a Meet link as people paste it, and nothing else', () => {
    expect(meetLinkOf(' https://meet.google.com/abc-defg-hij ')).toBe('https://meet.google.com/abc-defg-hij');
    expect(meetLinkOf('meet.google.com/abc-defg-hij?authuser=1')).toBe('https://meet.google.com/abc-defg-hij?authuser=1');
    expect(meetLinkOf('http://meet.google.com/abc-defg-hij')).toBe('https://meet.google.com/abc-defg-hij');
    for (const bad of ['', 'https://meet.google.com/', 'https://meet.google.com.evil.example/abc-defg-hij', 'https://zoom.us/j/1', 'javascript:alert(1)', 'https://meet.google.com/abcd-efg-hij']) {
      expect(meetLinkOf(bad), bad).toBeNull();
    }
  });
});
