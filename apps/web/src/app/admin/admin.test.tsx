import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { fakeAuth, PERMANENT } from '../../test/fakeAuth';
import { renderApp } from '../../test/renderApp';

// The operators' dead-letter page (/app/admin/dead-letters): SLO 5 says every dead letter is reviewed within one
// working day, and until now the only way to read or resolve one was the api with a hand-made ID token
// (docs/runbooks/production-incident.md §5.5). The api's ADMIN_UIDS is the guard; anyone else sees a plain refusal.
const calls: Array<{ method: string; path: string; search: string }> = [];
let handlers: Record<string, () => Response> = {};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const u = new URL(String(url));
  const method = init?.method ?? 'GET';
  calls.push({ method, path: u.pathname, search: u.search });
  return (handlers[`${method} ${u.pathname}${u.search}`] ?? handlers[`${method} ${u.pathname}`] ?? (() => json({ ok: true })))();
}) as typeof fetch;

const entry = (id: number, over: Record<string, unknown> = {}) => ({
  id, queue: 'summarize', noteId: `note-${id}`, workspaceId: 'workspace_u1', error: 'Vertex 503 after 10 attempts',
  attempts: 10, traceId: `trace-${id}`, reason: 'summarize_exhausted', createdAt: '2026-10-25T01:00:00.000Z', resolvedAt: null, ...over,
});

beforeEach(() => {
  calls.length = 0;
  handlers = { 'GET /v1/admin/dead-letters?limit=1000': () => json({ deadLetters: [entry(7), entry(8, { queue: 'sweep', reason: 'stuck_in_flight' })] }) };
});
afterEach(() => cleanup());

const open = () => renderApp('/app/admin/dead-letters', fakeAuth(PERMANENT).adapter, fetchImpl);

describe('the dead-letter page', () => {
  it('lists the unresolved dead letters with what an operator follows up', async () => {
    open();
    expect(await screen.findByRole('heading', { name: 'Dead letters' })).toBeTruthy();
    const row = (await screen.findByText('note-7')).closest('tr')!;
    expect(within(row).getByText('summarize')).toBeTruthy();
    expect(within(row).getByText('summarize_exhausted')).toBeTruthy();
    expect(within(row).getByText('10')).toBeTruthy();
    // The log query to follow it across services.
    expect(within(row).getByText('jsonPayload.traceId="trace-7"')).toBeTruthy();
    expect(screen.getByText('note-8')).toBeTruthy();
    expect(calls).toContainEqual({ method: 'GET', path: '/v1/admin/dead-letters', search: '?limit=1000' });
  });

  it('resolves one only once confirmed, and says resolving replays nothing', async () => {
    // As the api does: a resolved entry leaves the unresolved list.
    let resolved = false;
    handlers['POST /v1/admin/dead-letters/7/resolve'] = () => { resolved = true; return json({ ok: true, id: 7 }); };
    handlers['GET /v1/admin/dead-letters?limit=1000'] = () =>
      json({ deadLetters: [...(resolved ? [] : [entry(7)]), entry(8, { queue: 'sweep', reason: 'stuck_in_flight' })] });
    open();
    const row = (await screen.findByText('note-7')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Mark resolved' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/replays nothing/);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark resolved' }));
    await waitFor(() => expect(calls).toContainEqual({ method: 'POST', path: '/v1/admin/dead-letters/7/resolve', search: '' }));
    await waitFor(() => expect(screen.queryByText('note-7')).toBeNull());
    expect(screen.getByText('note-8')).toBeTruthy();
  });

  it('shows resolved ones too when asked', async () => {
    handlers['GET /v1/admin/dead-letters?includeResolved=true&limit=1000'] = () =>
      json({ deadLetters: [entry(5, { resolvedAt: '2026-10-24T09:00:00.000Z' })] });
    open();
    await screen.findByText('note-7');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show resolved' }));
    expect(await screen.findByText('note-5')).toBeTruthy();
    expect(within(screen.getByText('note-5').closest('tr')!).queryByRole('button', { name: 'Mark resolved' })).toBeNull();
  });

  // The api reads newest first, at most 1,000, with no offset: a full page says so, rather than hiding the rest.
  it('asks for as many as the api gives, and says when there may be older ones', async () => {
    handlers['GET /v1/admin/dead-letters?limit=1000'] = () =>
      json({ deadLetters: Array.from({ length: 1000 }, (_, i) => entry(i + 1)) });
    open();
    expect(await screen.findByText(/Showing the newest 1,000/)).toBeTruthy();
    expect(calls).toContainEqual({ method: 'GET', path: '/v1/admin/dead-letters', search: '?limit=1000' });
  }, 20_000);

  it('says when nothing is waiting', async () => {
    handlers['GET /v1/admin/dead-letters?limit=1000'] = () => json({ deadLetters: [] });
    open();
    expect(await screen.findByText(/Nothing is waiting/)).toBeTruthy();
  });

  it('tells anyone not on the operators list, and shows nothing', async () => {
    handlers['GET /v1/admin/dead-letters?limit=1000'] = () => json({ error: 'Forbidden' }, 403);
    open();
    expect(await screen.findByText(/for AlgoMinutes operators/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
