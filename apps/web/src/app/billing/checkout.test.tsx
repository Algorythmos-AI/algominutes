import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { fakeAuth, PERMANENT } from '../../test/fakeAuth';
import { fakeFeed, ORIGINS, renderApp } from '../../test/renderApp';
import { ApiError } from '../../lib/api/errors';
import { ApiProvider } from '../ApiContext';
import { AuthProvider } from '../auth/AuthContext';
import { BillingSuccessPage } from './BillingReturnPages';

// Pro on the web (docs/plans/RELEASE.md PR 28): Stripe Checkout for anyone without a subscription, the
// portal for one billed on the web, and the pages Stripe sends a buyer back to. The browser leaving for
// Stripe is `redirectTo`, stood in for here.
vi.mock('../../lib/billing/checkout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/billing/checkout')>();
  return { ...actual, redirectTo: vi.fn() };
});
const checkout = await import('../../lib/billing/checkout');

const ENT = { state: 'free_floor', plan: 'free', billingPeriod: '2026-10', includedMinutes: 0, usedMinutes: 0, remainingMinutes: 0, overQuota: true, source: 'free', rail: null };
const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
let handlers: Record<string, () => Response> = {};
const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(url)).pathname;
  calls.push({ path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : {} });
  return (handlers[path] ?? (() => new Response('{"ok":true}', { status: 200 })))();
}) as typeof fetch;
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  calls.length = 0;
  vi.mocked(checkout.redirectTo).mockClear();
  handlers = { '/v1/entitlement': json(200, ENT) };
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const open = (path = '/app/settings') => renderApp(path, fakeAuth(PERMANENT).adapter, fetchImpl, fakeFeed([]).feed);

describe('going Pro on the web', () => {
  it('anyone without a subscription starts a Stripe checkout, and the browser leaves for it', async () => {
    handlers['/v1/billing/checkout'] = json(200, { url: 'https://checkout.stripe.test/c/pay/cs_1' });
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Pro, yearly' }));
    await waitFor(() => expect(checkout.redirectTo).toHaveBeenCalledWith('https://checkout.stripe.test/c/pay/cs_1'));
    expect(calls.find((c) => c.path === '/v1/billing/checkout')?.body).toEqual({ productId: 'pro_annual', period: 'annual' });
  });

  it('beta minutes can buy too', async () => {
    handlers['/v1/entitlement'] = json(200, { ...ENT, state: 'active', plan: 'pro', source: 'grant' });
    open();
    expect(await screen.findByRole('button', { name: 'Pro, monthly' })).toBeTruthy();
  });

  it('says why a checkout could not start, and stays', async () => {
    handlers['/v1/billing/checkout'] = json(409, { error: 'Already subscribed', rail: 'apple_storekit' });
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Pro, monthly' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/already have Pro, through the App Store/);
    expect(checkout.redirectTo).not.toHaveBeenCalled();
    // The buttons work again.
    expect((screen.getByRole('button', { name: 'Pro, monthly' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a subscription billed on the web is managed in the portal; one from the App Store shows no buttons', async () => {
    handlers['/v1/entitlement'] = json(200, { ...ENT, state: 'active', plan: 'pro', source: 'subscription', rail: 'stripe' });
    handlers['/v1/billing/portal'] = json(200, { url: 'https://billing.stripe.test/p/session/1' });
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Manage subscription' }));
    await waitFor(() => expect(checkout.redirectTo).toHaveBeenCalledWith('https://billing.stripe.test/p/session/1'));
    expect(screen.queryByRole('button', { name: 'Pro, monthly' })).toBeNull();
    cleanup();
    handlers['/v1/entitlement'] = json(200, { ...ENT, state: 'active', plan: 'pro', source: 'subscription', rail: 'apple_storekit' });
    open();
    expect(await screen.findByText(/Billed through the App Store/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pro, monthly' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Manage subscription' })).toBeNull();
  });
});

describe('the messages', () => {
  const err = (status: number, body: unknown, kind: ConstructorParameters<typeof ApiError>[0] = 'bad_request') =>
    new ApiError(kind, { status, code: null, body, entitlement: null, retryAfterSec: null, traceId: null } as never);

  it('say what happened in plain words', () => {
    expect(checkout.checkoutErrorMessage(err(409, { rail: 'stripe' }, 'conflict'))).toBe('You already have Pro.');
    expect(checkout.checkoutErrorMessage(err(503, {}, 'server'))).toMatch(/isn’t on sale yet/);
    expect(checkout.checkoutErrorMessage(new Error('boom'))).toBe('Checkout couldn’t start. Please try again.');
    expect(checkout.portalErrorMessage(err(409, {}, 'conflict'))).toMatch(/no subscription billed on the web/);
  });

  it('only a subscription stops a purchase, and only a web one opens the portal', () => {
    const e = (source: string, rail: string | null = null) => ({ ...ENT, source, rail }) as never;
    expect(['free', 'trial', 'grant'].map((s) => checkout.canBuyPro(e(s)))).toEqual([true, true, true]);
    expect(checkout.canBuyPro(e('subscription', 'stripe'))).toBe(false);
    expect(checkout.canBuyPro(null)).toBe(false);
    expect(checkout.managedOnTheWeb(e('subscription', 'stripe'))).toBe(true);
    expect(checkout.managedOnTheWeb(e('subscription', 'apple_storekit'))).toBe(false);
    expect(checkout.managedOnTheWeb(e('grant'))).toBe(false);
  });
});

describe('back from Stripe', () => {
  it('waits for the webhook, then says the plan is Pro', async () => {
    let reads = 0;
    handlers['/v1/entitlement'] = () => {
      reads += 1;
      // A tester with beta minutes is `active` already: only the subscription itself confirms the purchase.
      return json(200, reads < 2 ? { ...ENT, state: 'active', plan: 'pro', source: 'grant' } : { ...ENT, state: 'active', plan: 'pro', source: 'subscription', rail: 'stripe' })();
    };
    open('/app/billing/success');
    expect(await screen.findByText('Confirming your subscription…')).toBeTruthy();
    expect(await screen.findByText('You’re on Pro', {}, { timeout: 4000 })).toBeTruthy();
    expect(reads).toBe(2); // not at the first read, whose beta minutes were `active` already
  });

  it('says plainly when the webhook takes longer, rather than waiting forever', async () => {
    render(
      <AuthProvider adapter={fakeAuth(PERMANENT).adapter}>
        <ApiProvider origins={ORIGINS} fetchImpl={fetchImpl}>
          <MemoryRouter>
            <BillingSuccessPage intervalMs={5} tries={3} />
          </MemoryRouter>
        </ApiProvider>
      </AuthProvider>,
    );
    expect(await screen.findByText(/Your payment went through\. Your plan updates in a minute or two/)).toBeTruthy();
    expect(calls.filter((c) => c.path === '/v1/entitlement')).toHaveLength(3);
  });

  it('a cancelled checkout charged nothing', async () => {
    open('/app/billing/cancel');
    expect(await screen.findByText('Checkout cancelled')).toBeTruthy();
    expect(screen.getByText(/Nothing was charged/)).toBeTruthy();
  });
});
