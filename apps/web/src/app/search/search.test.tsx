import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { fakeAuth, PERMANENT } from '../../test/fakeAuth';
import { fakeFeed, renderApp } from '../../test/renderApp';
import { forgetSearchPage, splitCitations } from './SearchPage';

afterEach(() => {
  cleanup();
  localStorage.clear();
  forgetSearchPage();
});

const hit = (noteId: string, startMs: number, chunkText: string) => ({ noteId, noteTitle: `Title ${noteId}`, chunkText, startMs, endMs: startMs + 5000 });

/** A chat stream the test writes into frame by frame. */
function sse() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => { ctl = c; } });
  const enc = new TextEncoder();
  return {
    response: () => new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    send: (frame: string) => ctl.enqueue(enc.encode(frame)),
    close: () => ctl.close(),
  };
}

const route = (handlers: Record<string, (body: Record<string, unknown>) => Response>) =>
  (async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    return (handlers[path] ?? (() => new Response('{"ok":true}', { status: 200 })))(body);
  }) as typeof fetch;

const openSearch = (fetchImpl: typeof fetch) => renderApp('/app/search', fakeAuth(PERMANENT).adapter, fetchImpl, fakeFeed([]).feed);

describe('search', () => {
  it("finds moments across notes, each linking to the note at that moment", async () => {
    const f = route({ '/v1/search': (b) => (b.query === 'budget' && b.k === 12 ? new Response(JSON.stringify({ hits: [hit('n1', 75_000, 'the budget is fine')] }), { status: 200 }) : new Response('{}', { status: 400 })) });
    openSearch(f);
    fireEvent.change(await screen.findByLabelText('Search your notes'), { target: { value: ' budget ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const link = await screen.findByRole('link', { name: /Title n1/ });
    expect(link.getAttribute('href')).toBe('/app/notes/n1?t=75000');
    expect(link.textContent).toMatch(/1:15.*the budget is fine/);
  });

  it('says when nothing was found, and when search fails', async () => {
    let fail = false;
    const f = route({ '/v1/search': () => (fail ? new Response('{"error":"internal"}', { status: 500 }) : new Response(JSON.stringify({ hits: [] }), { status: 200 })) });
    openSearch(f);
    fireEvent.change(await screen.findByLabelText('Search your notes'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Nothing found. Try other words.')).toBeTruthy();
    fail = true;
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/had a problem/);
  });
});

describe('ask your notes', () => {
  it('streams the answer, with its citations linked to their moments', async () => {
    const s = sse();
    const f = route({ '/v1/chat': (b) => { expect(b).toEqual({ query: 'What did we decide?' }); return s.response(); } });
    openSearch(f);
    fireEvent.click(await screen.findByRole('tab', { name: 'Ask your notes' }));
    fireEvent.change(screen.getByLabelText('Ask a question about your notes'), { target: { value: 'What did we decide?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    s.send(`event: citations\ndata: ${JSON.stringify({ hits: [hit('n1', 5000, 'launch Monday')] })}\n\n`);
    s.send('data: {"text":"You chose Monday "}\n\n');
    expect(await screen.findByText(/You chose Monday/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    s.send('data: {"text":"[1]."}\n\nevent: done\ndata: {}\n\n');
    s.close();
    const cite = await screen.findByRole('link', { name: 'Source 1: Title n1 at 0:05' });
    expect(cite.getAttribute('href')).toBe('/app/notes/n1?t=5000');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ask' })).toBeTruthy());
  });

  it('Stop ends the answer and says so; a cut-off answer offers Try again', async () => {
    const first = sse();
    let n = 0;
    const second = sse();
    const f = route({ '/v1/chat': () => (++n === 1 ? first.response() : second.response()) });
    openSearch(f);
    fireEvent.click(await screen.findByRole('tab', { name: 'Ask your notes' }));
    fireEvent.change(screen.getByLabelText('Ask a question about your notes'), { target: { value: 'q' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    first.send('data: {"text":"partial"}\n\n');
    await screen.findByText('partial');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Stopped.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Ask a question about your notes'), { target: { value: 'again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    second.send('data: {"text":"half"}\n\nevent: error\ndata: {"error":"stream_failed"}\n\n');
    second.close();
    expect((await screen.findByRole('alert')).textContent).toMatch(/cut short/);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('splits [n] citations out of the text', () => {
    expect(splitCitations('A [1] and [12].')).toEqual([{ text: 'A ' }, { cite: 1 }, { text: ' and ' }, { cite: 12 }, { text: '.' }]);
    expect(splitCitations('none')).toEqual([{ text: 'none' }]);
  });
});

describe('leaving the page', () => {
  it('keeps the query and results for Back, after a hit is opened', async () => {
    const f = route({ '/v1/search': () => new Response(JSON.stringify({ hits: [hit('n1', 75_000, 'the budget is fine')] }), { status: 200 }) });
    const router = openSearch(f);
    fireEvent.change(await screen.findByLabelText('Search your notes'), { target: { value: 'budget' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByRole('link', { name: /Title n1/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/notes/n1'));
    await act(() => router.navigate(-1));
    expect(await screen.findByRole('link', { name: /Title n1/ })).toBeTruthy();
    expect((screen.getByLabelText('Search your notes') as HTMLInputElement).value).toBe('budget');
  });

  it('ends an answer still streaming, and shows it as stopped on return', async () => {
    const s = sse();
    let signal: AbortSignal | undefined;
    const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(url)).pathname === '/v1/chat') {
        signal = init?.signal ?? undefined;
        return s.response();
      }
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;
    const router = openSearch(f);
    fireEvent.click(await screen.findByRole('tab', { name: 'Ask your notes' }));
    fireEvent.change(screen.getByLabelText('Ask a question about your notes'), { target: { value: 'q' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    s.send('data: {"text":"partial"}\n\n');
    await screen.findByText('partial');
    await act(() => router.navigate('/settings'));
    await waitFor(() => expect(signal?.aborted).toBe(true));
    await act(() => router.navigate('/search'));
    expect(await screen.findByText('partial')).toBeTruthy();
    expect(screen.getByText('Stopped.')).toBeTruthy();
  });
});

describe('the tabs', () => {
  it('arrow keys move between them, and each controls its panel', async () => {
    openSearch(route({}));
    const searchTab = await screen.findByRole('tab', { name: 'Search transcripts' });
    expect(searchTab.getAttribute('aria-controls')).toBe('panel-search');
    fireEvent.keyDown(searchTab, { key: 'ArrowRight' });
    const ask = screen.getByRole('tab', { name: 'Ask your notes' });
    expect(ask.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(ask);
    expect(screen.getByRole('tabpanel', { name: 'Ask your notes' })).toBeTruthy();
  });
});
