import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DiagnosticsPage, type DiagEnv } from './DiagnosticsPage';
import { forgetLastTrace, startTrace } from '../../lib/diagnostics/signInTrace';

afterEach(() => {
  cleanup();
  forgetLastTrace();
});

const KEY = 'AIzaFAKEFAKEFAKEFAKE1234';
const env = (over: Partial<DiagEnv> = {}): DiagEnv => ({
  config: () => ({ host: 'localhost:3000', authDomain: 'algominutes-staging.firebaseapp.com', projectId: 'algominutes-staging', apiKey: KEY, apiOrigin: 'https://api.example.test' }),
  cspHeader: async () => "script-src 'self' https://apis.google.com; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://api.example.test; frame-src 'self'",
  probe: async () => false,
  fetchImpl: (async (url: RequestInfo | URL) =>
    String(url).includes('identitytoolkit') ? new Response(JSON.stringify({ authorizedDomains: ['localhost', 'algominutes-staging.firebaseapp.com'] }), { status: 200 }) : new Response('{"ok":true}', { status: 200 })) as typeof fetch,
  ...over,
});

describe('the sign-in check page', () => {
  it("lists every check, says what to fix, and shows the last attempt's trace", async () => {
    startTrace('apple', 'signIn', 'algominutes-staging.firebaseapp.com', () => 0).finish('cancelled');
    render(<DiagnosticsPage env={env()} />);
    // frame-src lacks Firebase's domain, and (here) the handler frame doesn't load: 2 to fix.
    expect(await screen.findByRole('heading', { name: '2 to fix' })).toBeTruthy();
    expect(screen.getByText(/Add https:\/\/algominutes-staging\.firebaseapp\.com to \/app's frame-src/)).toBeTruthy();
    expect(screen.getByText(/apple, cancelled after/)).toBeTruthy();
  }, 15_000);

  it('copies a report that masks the key', async () => {
    const write = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    render(<DiagnosticsPage env={env()} />);
    await screen.findByRole('heading', { name: /to fix|checks out/ }, { timeout: 12_000 });
    fireEvent.click(screen.getByRole('button', { name: 'Copy report' }));
    await waitFor(() => expect(write).toHaveBeenCalled());
    const report = (write.mock.calls[0] as unknown as [string])[0];
    expect(report).toContain('AIza…1234');
    expect(report).not.toContain(KEY);
    expect(JSON.parse(report)).toMatchObject({ projectId: 'algominutes-staging', authDomain: 'algominutes-staging.firebaseapp.com' });
  }, 15_000);

  it("says so plainly when the build isn't configured for sign-in", () => {
    render(<DiagnosticsPage env={env({ config: () => { throw new Error('VITE_FIREBASE_API_KEY is not set'); } })} />);
    expect(screen.getByRole('alert').textContent).toMatch(/VITE_FIREBASE_API_KEY is not set/);
  });
});
