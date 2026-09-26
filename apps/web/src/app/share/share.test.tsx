import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { fakeAuth } from '../../test/fakeAuth';
import { renderApp } from '../../test/renderApp';

afterEach(cleanup);

const SHARED = {
  note: { title: 'Board meeting', createdAt: '2026-09-26T01:00:00.000Z', scope: 'summary' },
  summary: { gist: 'Budget approved.', actionItems: ['Send minutes'], keyDecisions: ['Approve budget'] },
  transcript: { lines: [{ id: 1, speakerTag: 1, speakerName: 'Chair', startMs: 0, text: 'Welcome.' }], truncated: true },
  expiresAt: '2026-10-03T01:00:00.000Z',
  redaction: { applied: true, scheme: 's' },
};

describe('a shared note', () => {
  it('opens without signing in, from the public read, and shows what was shared', async () => {
    const sent: Array<{ url: string; auth: string | null; body: unknown }> = [];
    renderApp('/app/s/tok_123', fakeAuth(null).adapter, (async (url, init) => {
      sent.push({ url: String(url), auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(SHARED), { status: 200 });
    }) as typeof fetch);
    expect(await screen.findByRole('heading', { level: 1, name: 'Board meeting' })).toBeTruthy();
    expect(screen.getByText('Budget approved.')).toBeTruthy();
    expect(screen.getByText('Send minutes')).toBeTruthy();
    expect(screen.getByText('Welcome.')).toBeTruthy();
    expect(screen.getByText('The transcript is long, so only its beginning is shown.')).toBeTruthy();
    expect(sent).toEqual([{ url: 'https://api.example.test/v1/shares/read', auth: null, body: { token: 'tok_123' } }]);
  });

  it('an expired, revoked or made-up link reads the same', async () => {
    renderApp('/app/s/nope', fakeAuth(null).adapter, (async () => new Response('{"error":"not_found"}', { status: 404 })) as typeof fetch);
    expect(await screen.findByRole('heading', { name: "This shared note isn't available" })).toBeTruthy();
  });
});
