import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { fakeAuth, PERMANENT } from '../../test/fakeAuth';
import { fakeFeed, renderApp } from '../../test/renderApp';
import { splitCitations } from './SearchPage';

afterEach(() => {
  cleanup();
  localStorage.clear();
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
