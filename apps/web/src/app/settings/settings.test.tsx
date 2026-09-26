import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { fakeAuth, GUEST, PERMANENT } from '../../test/fakeAuth';
import { fakeFeed, renderApp } from '../../test/renderApp';

const ENT = { state: 'active', plan: 'free', billingPeriod: '2026-09', includedMinutes: 60, usedMinutes: 12.4, remainingMinutes: 47.6, overQuota: false };
const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
let handlers: Record<string, () => Response> = {};
const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(url)).pathname;
  calls.push({ path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : {} });
  return (handlers[path] ?? (() => new Response('{"ok":true}', { status: 200 })))();
}) as typeof fetch;

beforeEach(() => {
  calls.length = 0;
  handlers = { '/v1/entitlement': () => new Response(JSON.stringify(ENT), { status: 200 }) };
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

const open = (user = PERMANENT) => {
  const auth = fakeAuth(user);
  const router = renderApp('/app/settings', auth.adapter, fetchImpl, fakeFeed([]).feed);
  return { auth, router };
};

describe('settings', () => {
  it('shows the account, a copyable User ID, and the plan', async () => {
    const write = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    open();
    expect(await screen.findByText('a@example.test')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(write).toHaveBeenCalledWith('u1'));
    expect(await screen.findByText(/Free plan\. 12 of 60 minutes used this month\./)).toBeTruthy();
  });

  it('a guest is told the notes are not backed up', async () => {
    open(GUEST);
    expect(await screen.findByText(/Guest \(not backed up\)/)).toBeTruthy();
  });

  it('data retention is sent to the api, and remembered for display', async () => {
    open();
    fireEvent.click(await screen.findByLabelText('Delete after 90 days'));
    await waitFor(() => expect(calls.find((c) => c.path === '/v1/account/retention')?.body).toEqual({ retentionDays: 90 }));
    expect(localStorage.getItem('retention_days.u1')).toBe('90');
    fireEvent.click(screen.getByLabelText('Keep until I delete them'));
    await waitFor(() => expect(calls.filter((c) => c.path === '/v1/account/retention').at(-1)?.body).toEqual({ retentionDays: null }));
  });

  it('a support message carries diagnostics, never content', async () => {
    open();
    fireEvent.change(await screen.findByLabelText(/Tell us what happened/), { target: { value: ' The summary missed a decision. ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Sent. Thank you.');
    const body = calls.find((c) => c.path === '/v1/support')!.body;
    expect(body).toMatchObject({ kind: 'contact', message: 'The summary missed a decision.', appVersion: '1.0.0', platform: 'web' });
    expect(Object.keys(body).sort()).toEqual(['appVersion', 'device', 'kind', 'message', 'platform']);
  });
});

describe('deleting the account', () => {
  const confirm = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Delete my account' }));
    const dlg = screen.getByRole('dialog');
    const go = within(dlg).getByRole('button', { name: 'Delete account' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(within(dlg).getByLabelText('Type DELETE to confirm:'), { target: { value: 'DELETE' } });
    fireEvent.click(go);
    return dlg;
  };

  it('needs DELETE typed, deletes through the api, signs out and says so', async () => {
    handlers['/v1/account/delete'] = () => new Response(JSON.stringify({ ok: true, summary: { workspacesAffected: 1, notesDeleted: 2, notesNotFound: 0, pgMembershipsDeleted: 1, firestoreErrors: 0, pgErrors: 0, authDeleted: true } }), { status: 200 });
    const { auth } = open();
    await confirm();
    await screen.findByRole('heading', { name: 'Sign in to AlgoMinutes' });
    expect(calls.some((c) => c.path === '/v1/account/delete')).toBe(true);
    expect(auth.adapter.signOut).toHaveBeenCalled();
    expect(auth.adapter.revokeApple).not.toHaveBeenCalled();
  });

  it("an Apple account revokes the app's Apple access first, and deletes nothing if the user backs out", async () => {
    const apple = { ...PERMANENT, providers: ['apple.com'] };
    const { auth } = open(apple);
    auth.adapter.revokeApple.mockResolvedValueOnce(false);
    const dlg = await confirm();
    expect((await within(dlg).findByRole('alert')).textContent).toMatch(/Sign in with Apple to confirm/);
    expect(calls.some((c) => c.path === '/v1/account/delete')).toBe(false);
    fireEvent.click(within(dlg).getByRole('button', { name: 'Delete account' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/v1/account/delete')).toBe(true));
    expect(auth.adapter.revokeApple).toHaveBeenCalledTimes(2);
  });

  it('a refused delete keeps the account and says so', async () => {
    handlers['/v1/account/delete'] = () => new Response('{"error":"internal"}', { status: 500 });
    const { auth } = open();
    const dlg = await confirm();
    expect((await within(dlg).findByRole('alert')).textContent).toMatch(/wasn’t deleted/);
    expect(auth.adapter.signOut).not.toHaveBeenCalled();
  });
});
