import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { PRIVACY_VERSION, TERMS_VERSION } from '@algominutes/contracts';
import { fakeAuth, GUEST, PERMANENT } from '../../test/fakeAuth';
import { renderApp } from '../../test/renderApp';
import { safeNext } from './SignInPage';
import { recordTermsAcceptanceIfNeeded } from './terms';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const heading = (name: string) => screen.findByRole('heading', { level: 1, name });

describe('sign-in', () => {
  it('a signed-out visitor is sent to sign-in, and comes back to the page they asked for', async () => {
    const auth = fakeAuth(null);
    const router = renderApp('/app/search?q=budget', auth.adapter);
    await heading('Sign in to AlgoMinutes');
    expect(router.state.location.pathname).toBe('/app/sign-in');
    expect(router.state.location.search).toBe(`?next=${encodeURIComponent('/search?q=budget')}`);
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    await heading('Search');
    expect(auth.adapter.signIn).toHaveBeenCalledWith('google');
    expect(router.state.location.pathname).toBe('/app/search');
  });

  it('Apple, Google and guest each go through the adapter', async () => {
    for (const [name, call] of [['Continue with Apple', 'signIn'], ['Try it as a guest', 'continueAsGuest']] as const) {
      const auth = fakeAuth(null);
      renderApp('/app', auth.adapter);
      fireEvent.click(await screen.findByRole('button', { name }));
      await heading('Your notes');
      expect(auth.adapter[call]).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });

  it("shows a sentence, not Firebase's code, when sign-in fails; a closed popup shows nothing", async () => {
    const auth = fakeAuth(null);
    auth.adapter.signIn.mockRejectedValueOnce(Object.assign(new Error('Firebase: Error (auth/unauthorized-domain).'), { code: 'auth/unauthorized-domain' }));
    renderApp('/app', auth.adapter);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/isn't authorised for sign-in/);
    expect(screen.getByRole('alert').textContent).not.toMatch(/auth\//);

    auth.adapter.signIn.mockResolvedValueOnce(false); // the user closed the popup
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it("a failed guest start doesn't blame Google", async () => {
    const auth = fakeAuth(null);
    auth.adapter.continueAsGuest.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'auth/operation-not-allowed' }));
    renderApp('/app', auth.adapter);
    fireEvent.click(await screen.findByRole('button', { name: 'Try it as a guest' }));
    expect((await screen.findByRole('alert')).textContent).toBe("Guest sign-in isn't available yet. Please use the other sign-in option for now.");
  });

  it('links the Terms and Privacy Policy on the public site', async () => {
    renderApp('/app/sign-in', fakeAuth(null).adapter);
    await heading('Sign in to AlgoMinutes');
    expect(new URL(screen.getByRole('link', { name: 'Terms of Service' }).getAttribute('href')!).pathname).toBe('/terms');
    expect(new URL(screen.getByRole('link', { name: 'Privacy Policy' }).getAttribute('href')!).pathname).toBe('/privacy');
  });

  it('next= only ever leads inside the app', () => {
    expect(safeNext('/notes/1')).toBe('/notes/1');
    for (const bad of [null, '', 'https://evil.test', '//evil.test', '/\\evil.test', 'notes']) expect(safeNext(bad), String(bad)).toBe('/');
  });
});

describe('a guest', () => {
  it('can create an account in place, keeping the uid', async () => {
    const auth = fakeAuth(GUEST);
    renderApp('/app', auth.adapter);
    fireEvent.click(await screen.findByRole('button', { name: 'Create account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(auth.adapter.linkGuest).toHaveBeenCalledWith('google');
    expect(auth.user).toMatchObject({ uid: 'g1', isAnonymous: false });
    expect(screen.queryByRole('button', { name: 'Create account' })).toBeNull();
  });

  it('is asked before switching to an Apple or Google account that already has AlgoMinutes', async () => {
    const auth = fakeAuth(GUEST);
    const switchToExisting = vi.fn(async () => auth.set(PERMANENT));
    auth.adapter.linkGuest.mockResolvedValueOnce({ outcome: 'conflict', switchToExisting });
    renderApp('/app', auth.adapter);
    fireEvent.click(await screen.findByRole('button', { name: 'Create account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Apple' }));
    expect(await screen.findByRole('heading', { name: 'That account already has AlgoMinutes' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep using these notes' }));
    expect(switchToExisting).not.toHaveBeenCalled();
    expect(auth.user?.uid).toBe('g1');

    auth.adapter.linkGuest.mockResolvedValueOnce({ outcome: 'conflict', switchToExisting });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Apple' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to that account' }));
    await waitFor(() => expect(switchToExisting).toHaveBeenCalledTimes(1));
  });

  it("is asked before signing out, since a guest account can't be got back", async () => {
    const auth = fakeAuth(GUEST);
    renderApp('/app', auth.adapter);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign out of this guest account?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(auth.adapter.signOut).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Sign out' }));
    await heading('Sign in to AlgoMinutes');
    expect(auth.adapter.signOut).toHaveBeenCalledTimes(1);
  });

  it('a sign-out or account switch that fails says so, instead of an unhandled rejection', async () => {
    const auth = fakeAuth(PERMANENT);
    auth.adapter.signOut.mockRejectedValueOnce(new Error('network'));
    renderApp('/app', auth.adapter);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('Signing out didn’t complete. Try again.')).toBeTruthy();
    cleanup();

    const g = fakeAuth(GUEST);
    g.adapter.linkGuest.mockResolvedValueOnce({ outcome: 'conflict', switchToExisting: async () => { throw Object.assign(new Error('x'), { code: 'auth/network-request-failed' }); } });
    renderApp('/app', g.adapter);
    fireEvent.click(await screen.findByRole('button', { name: 'Create account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to that account' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/network problem/);
  });

  it('a permanent account signs out straight away', async () => {
    const auth = fakeAuth(PERMANENT);
    renderApp('/app', auth.adapter);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await heading('Sign in to AlgoMinutes');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Terms acceptance', () => {
  const api = () => ({ acceptTerms: vi.fn(async () => ({ ok: true as const })) });
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };

  it('is recorded once per account and version, never for a guest', async () => {
    const a = api();
    const store = memory();
    expect(await recordTermsAcceptanceIfNeeded(a, GUEST, store)).toBe(false);
    expect(await recordTermsAcceptanceIfNeeded(a, PERMANENT, store)).toBe(true);
    expect(await recordTermsAcceptanceIfNeeded(a, PERMANENT, store)).toBe(false);
    expect(a.acceptTerms).toHaveBeenCalledTimes(1);
    expect(a.acceptTerms).toHaveBeenCalledWith({ termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION, appVersion: '1.0.0', platform: 'web' });
  });

  it('is retried next time when the post fails, and still posted when storage is blocked', async () => {
    const a = api();
    a.acceptTerms.mockRejectedValueOnce(new Error('offline'));
    const store = memory();
    expect(await recordTermsAcceptanceIfNeeded(a, PERMANENT, store)).toBe(false);
    expect(await recordTermsAcceptanceIfNeeded(a, PERMANENT, store)).toBe(true);
    const blocked = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('SecurityError'); } };
    expect(await recordTermsAcceptanceIfNeeded(a, PERMANENT, blocked)).toBe(true);
  });

  it('the app records it on sign-in, with the token of the account signing in', async () => {
    const sent: Array<{ url: string; auth: string | null }> = [];
    const auth = fakeAuth(null);
    renderApp('/app', auth.adapter, async (url, init) => {
      sent.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    await waitFor(() => expect(sent.map((s) => s.url)).toContain('https://api.example.test/v1/account/accept-terms'));
    expect(sent.find((s) => s.url.endsWith('/accept-terms'))!.auth).toBe('Bearer token-for-google-uid');
    // Once, though sign-in re-renders the app several times (busy, then signed in).
    await new Promise((r) => setTimeout(r, 50));
    expect(sent.filter((s) => s.url.endsWith('/accept-terms'))).toHaveLength(1);
  });

  it('two calls at the same moment post once', async () => {
    const a = api();
    const store = memory();
    const [x, y] = await Promise.all([recordTermsAcceptanceIfNeeded(a, PERMANENT, store), recordTermsAcceptanceIfNeeded(a, PERMANENT, store)]);
    expect([x, y].sort()).toEqual([false, true]);
    expect(a.acceptTerms).toHaveBeenCalledTimes(1);
  });

  it('a guest who creates an account records the acceptance then, without a reload', async () => {
    const sent: string[] = [];
    const auth = fakeAuth(GUEST);
    renderApp('/app', auth.adapter, async (url) => { sent.push(String(url)); return new Response(JSON.stringify({ ok: true }), { status: 200 }); });
    await screen.findByRole('button', { name: 'Create account' });
    expect(sent.filter((u) => u.endsWith('/accept-terms'))).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    await waitFor(() => expect(sent.filter((u) => u.endsWith('/accept-terms'))).toHaveLength(1));
  });
});

