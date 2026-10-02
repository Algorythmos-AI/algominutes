import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { fakeAuth, GUEST, PERMANENT } from '../../test/fakeAuth';
import { fakeFeed, renderApp } from '../../test/renderApp';
import { shortens } from './SettingsPage';

const ENT = { state: 'active', plan: 'free', billingPeriod: '2026-09', includedMinutes: 60, usedMinutes: 12.4, remainingMinutes: 47.6, overQuota: false };
const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
// Keyed by path, or by "METHOD path" where one path answers two ways.
let handlers: Record<string, () => Response | Promise<Response>> = {};
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(url)).pathname;
  const method = init?.method ?? 'GET';
  calls.push({ method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : {} });
  return (handlers[`${method} ${path}`] ?? handlers[path] ?? (() => new Response('{"ok":true}', { status: 200 })))();
}) as typeof fetch;

beforeEach(() => {
  calls.length = 0;
  handlers = {
    '/v1/entitlement': () => json(ENT),
    'GET /v1/account/retention': () => json({ retentionDays: null }),
  };
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
    // RELEASE.md rev 11, H18: a bar, what's left, and the day they renew.
    const bar = screen.getByRole('meter', { name: 'Minutes used this month' });
    expect([bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemax')]).toEqual(['12', '60']);
    expect(screen.getByText('48 left. Your minutes renew on 1 October.')).toBeTruthy();
  });

  it('the plan card takes an invite code: sent trimmed, and the new minutes are shown', async () => {
    handlers['/v1/beta/redeem'] = () => new Response(JSON.stringify({
      entitlement: { ...ENT, plan: 'pro', includedMinutes: 600, usedMinutes: 0, remainingMinutes: 600 },
      grantEndsAt: '2026-10-29T00:00:00.000Z', notetaker: false,
    }), { status: 200 });
    open();
    fireEvent.change(await screen.findByLabelText('Invite code'), { target: { value: '  BETA-7K2QX-M9D4R-TW8HN ' } }); // gitleaks:allow
    fireEvent.click(screen.getByRole('button', { name: 'Add minutes' }));
    expect(await screen.findByText(/You have 600 recording minutes, until 29 October\./)).toBeTruthy();
    expect(calls.find((c) => c.path === '/v1/beta/redeem')?.body).toEqual({ code: 'BETA-7K2QX-M9D4R-TW8HN' }); // gitleaks:allow
    expect(await screen.findByText(/Pro plan\. 0 of 600 minutes used this month\./)).toBeTruthy();
  });

  // RELEASE.md PR 26b: where the minutes come from.
  it("says a grant's minutes are beta minutes, never a purchase", async () => {
    handlers['/v1/entitlement'] = () => new Response(JSON.stringify({ ...ENT, plan: 'pro', source: 'grant', rail: null }), { status: 200 });
    open();
    expect(await screen.findByText(/Pro plan \(beta minutes\)\. 12 of 60 minutes used this month\./)).toBeTruthy();
    expect(screen.queryByText(/Billed through the App Store/)).toBeNull();
  });

  it('says where an App Store subscription is managed', async () => {
    handlers['/v1/entitlement'] = () => new Response(JSON.stringify({ ...ENT, plan: 'pro', source: 'subscription', rail: 'apple_storekit' }), { status: 200 });
    open();
    expect(await screen.findByText(/Pro plan\. 12 of 60/)).toBeTruthy();
    expect(screen.getByText(/Billed through the App Store/)).toBeTruthy();
  });

  it('a subscription billed on the web is not sent to the App Store', async () => {
    handlers['/v1/entitlement'] = () => new Response(JSON.stringify({ ...ENT, plan: 'pro', source: 'subscription', rail: 'stripe' }), { status: 200 });
    open();
    expect(await screen.findByText(/Pro plan\. 12 of 60/)).toBeTruthy();
    expect(screen.queryByText(/Billed through the App Store/)).toBeNull();
  });

  it('a refused invite code says why', async () => {
    handlers['/v1/beta/redeem'] = () => new Response(JSON.stringify({ error: 'invite_used_up' }), { status: 409 });
    open();
    fireEvent.change(await screen.findByLabelText('Invite code'), { target: { value: 'BETA-0000A-1111B-2222C' } }); // gitleaks:allow
    fireEvent.click(screen.getByRole('button', { name: 'Add minutes' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/used as many times as it allows/);
  });

  it('a guest is told the notes are not backed up', async () => {
    open(GUEST);
    expect(await screen.findByText(/Guest \(not backed up\)/)).toBeTruthy();
  });

  it('data retention is saved only on Save, and a limit that deletes notes is confirmed first', async () => {
    open();
    const retention = () => calls.filter((c) => c.method === 'POST' && c.path === '/v1/account/retention');
    // Moving through the options (as the arrow keys do) saves nothing.
    fireEvent.click(await screen.findByLabelText('Delete after 30 days'));
    fireEvent.click(screen.getByLabelText('Delete after 90 days'));
    expect(retention()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete notes older than 90 days?' });
    expect(dialog.textContent).toMatch(/permanently deleted/);
    expect(retention()).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete after 90 days' }));
    await waitFor(() => expect(retention().map((c) => c.body)).toEqual([{ retentionDays: 90 }]));
    expect(localStorage.getItem('retention_days.u1')).toBe('90');
    // Keeping notes longer deletes nothing, so it needs no confirmation.
    fireEvent.click(screen.getByLabelText('Keep until I delete them'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(retention().at(-1)?.body).toEqual({ retentionDays: null }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cancelling the confirmation saves nothing', async () => {
    open();
    fireEvent.click(await screen.findByLabelText('Delete after 30 days'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/v1/account/retention')).toEqual([]);
  });

  it("shows the account's retention, set on another device, over this browser's old copy", async () => {
    localStorage.setItem('retention_days.u1', '7');
    handlers['GET /v1/account/retention'] = () => json({ retentionDays: 365 });
    open();
    await waitFor(() => expect((screen.getByLabelText('Delete after 365 days') as HTMLInputElement).checked).toBe(true));
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(localStorage.getItem('retention_days.u1')).toBe('365');
  });

  it("a choice made before the account's answers is kept, and Save compares it with the account's", async () => {
    let answer!: (r: Response) => void;
    handlers['GET /v1/account/retention'] = () => new Promise<Response>((r) => { answer = r; });
    open();
    fireEvent.click(await screen.findByLabelText('Delete after 90 days'));
    // The radios render before the GET is sent; answer it only once it has been.
    await waitFor(() => expect(answer).toBeTypeOf('function'));
    answer(json({ retentionDays: 30 }));
    await waitFor(() => expect(localStorage.getItem('retention_days.u1')).toBe('30'));
    expect((screen.getByLabelText('Delete after 90 days') as HTMLInputElement).checked).toBe(true);
    // Longer than the account's 30 days deletes nothing: saved without a confirmation.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.path === '/v1/account/retention').map((c) => c.body)).toEqual([{ retentionDays: 90 }]));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('knows which changes delete notes', () => {
    expect(shortens(undefined, 365)).toBe(true);
    expect(shortens(null, 365)).toBe(true);
    expect(shortens(90, 30)).toBe(true);
    expect(shortens(30, 90)).toBe(false);
    expect(shortens(30, null)).toBe(false);
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

  // RELEASE.md PR 28b; App Review 5.1.1(v).
  it('says, before deleting, that an App Store subscription must be cancelled there', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete my account' }));
    expect(await screen.findByText(/A subscription bought in the App Store isn’t cancelled with your account/)).toBeTruthy();
    expect(screen.getByText(/One bought on the web is cancelled for you/)).toBeTruthy();
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

  it('an Apple window the browser blocks says how to fix it, and deletes nothing', async () => {
    const { auth } = open({ ...PERMANENT, providers: ['apple.com'] });
    auth.adapter.revokeApple.mockRejectedValueOnce(Object.assign(new Error('blocked'), { code: 'auth/popup-blocked' }));
    const dlg = await confirm();
    expect((await within(dlg).findByRole('alert')).textContent).toMatch(/blocked the Apple window\. Allow pop-ups/);
    expect(calls.some((c) => c.path === '/v1/account/delete')).toBe(false);
  });

  it('a refused delete keeps the account and says so', async () => {
    handlers['/v1/account/delete'] = () => new Response('{"error":"internal"}', { status: 500 });
    const { auth } = open();
    const dlg = await confirm();
    expect((await within(dlg).findByRole('alert')).textContent).toMatch(/wasn’t deleted/);
    expect(auth.adapter.signOut).not.toHaveBeenCalled();
  });
});
