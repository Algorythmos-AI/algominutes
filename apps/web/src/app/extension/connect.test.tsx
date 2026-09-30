import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { fakeAuth, PERMANENT } from '../../test/fakeAuth';
import { fakeFeed, renderApp } from '../../test/renderApp';
import { extensionIdsFromEnv, signOutExtensions } from '../../lib/extension/bridge';

// "Connect the extension" (RELEASE.md PR 37a): the page finds the installed extension, asks the api for a
// one-time code bound to the extension's verifier hash, and hands the code over.
const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const EDGE = 'ponmlkjihgfedcbaponmlkjihgfedcba';

const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
let linkAnswer: () => Response = () => new Response(JSON.stringify({ code: 'c'.repeat(43), expiresAt: '2026-09-30T00:01:00.000Z' }), { status: 200 });
// The app's shell makes its own calls on load; these tests look at the one this page makes.
const linkCalls = () => calls.filter((c) => c.path === '/v1/auth/extension-link');
const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(url)).pathname;
  calls.push({ path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : {} });
  if (path === '/v1/auth/extension-link') return linkAnswer();
  return new Response('{}', { status: 200 });
}) as typeof fetch;

// chrome.runtime as Chrome gives it to a page: an installed extension answers, a missing one sets lastError.
type Message = { type: string; code?: string };
type FakeRuntime = { lastError?: { message: string }; sendMessage(id: string, message: Message, cb: (r: unknown) => void): void };
type WithChrome = { chrome?: { runtime: FakeRuntime } };
const sent: Array<{ id: string; message: Message }> = [];
function installChrome(extensions: Record<string, (message: Message) => unknown>) {
  const runtime: FakeRuntime = {
    lastError: undefined,
    sendMessage(id, message, cb) {
      sent.push({ id, message });
      const ext = Object.hasOwn(extensions, id) ? extensions[id] : undefined;
      queueMicrotask(() => {
        runtime.lastError = ext ? undefined : { message: 'Could not establish connection. Receiving end does not exist.' };
        cb(ext ? ext(message) : undefined);
        runtime.lastError = undefined;
      });
    },
  };
  (globalThis as WithChrome).chrome = { runtime };
}
const extension = (linkResult: unknown = { ok: true, uid: 'u1' }) => (m: Message) =>
  m.type === 'hello' ? { ok: true, verifierHash: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', version: '1.0.0' } : m.type === 'link' ? linkResult : { ok: true };

beforeEach(() => {
  calls.length = 0;
  sent.length = 0;
  linkAnswer = () => new Response(JSON.stringify({ code: 'c'.repeat(43), expiresAt: '2026-09-30T00:01:00.000Z' }), { status: 200 });
  vi.stubEnv('VITE_EXTENSION_IDS', `${EXT},${EDGE}`);
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  delete (globalThis as WithChrome).chrome;
});

const open = () => renderApp('/app/connect-extension', fakeAuth(PERMANENT).adapter, fetchImpl, fakeFeed([]).feed);
const connect = async () => fireEvent.click(await screen.findByRole('button', { name: 'Connect the extension' }));

describe('connect the extension', () => {
  it('finds the installed one, gets a code for its verifier, and hands it over', async () => {
    installChrome({ [EDGE]: extension() });
    open();
    await connect();
    expect(await screen.findByText(/Connected\. The extension is signed in/)).toBeTruthy();
    expect(linkCalls()).toEqual([{ path: '/v1/auth/extension-link', body: { extensionId: EDGE, verifierHash: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM' } }]);
    expect(sent.map((s) => [s.id, s.message.type])).toEqual([[EXT, 'hello'], [EDGE, 'hello'], [EDGE, 'link']]);
    expect(sent.at(-1)!.message).toEqual({ type: 'link', code: 'c'.repeat(43) });
  });

  it('an extension that refuses this site (built for another one) is passed over', async () => {
    installChrome({ [EXT]: () => ({ ok: false, error: 'origin' }), [EDGE]: extension() });
    open();
    await connect();
    expect(await screen.findByText(/Connected\./)).toBeTruthy();
    expect(linkCalls()[0]!.body.extensionId).toBe(EDGE);
  });

  it('nothing happens until the user asks', async () => {
    installChrome({ [EXT]: extension() });
    open();
    await screen.findByRole('button', { name: 'Connect the extension' });
    expect(sent).toHaveLength(0);
    expect(linkCalls()).toHaveLength(0);
  });

  it('no extension installed: says to install it, and asks the api for nothing', async () => {
    installChrome({});
    open();
    await connect();
    expect(await screen.findByText(/Install the AlgoMinutes extension first/)).toBeTruthy();
    expect(linkCalls()).toHaveLength(0);
  });

  it('a browser that can\'t run it says so', async () => {
    open();
    await connect();
    expect(await screen.findByText(/works in Chrome and Microsoft Edge/)).toBeTruthy();
  });

  it('no extension ids in this build: not available yet', async () => {
    vi.stubEnv('VITE_EXTENSION_IDS', '');
    installChrome({ [EXT]: extension() });
    open();
    await connect();
    expect(await screen.findByText(/isn’t available yet/)).toBeTruthy();
    expect(sent).toHaveLength(0);
  });

  it('the api refusing (no extension allowed yet) shows its words, and nothing is handed over', async () => {
    linkAnswer = () => new Response(JSON.stringify({ error: 'feature_disabled' }), { status: 503 });
    installChrome({ [EXT]: extension() });
    open();
    await connect();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(sent.filter((s) => s.message.type === 'link')).toHaveLength(0);
  });

  it('an extension too old for the api says to update it', async () => {
    installChrome({ [EXT]: extension({ ok: false, error: 'please_update' }) });
    open();
    await connect();
    expect(await screen.findByText(/Your AlgoMinutes extension is out of date/)).toBeTruthy();
  });
});

describe('signing out of the web app', () => {
  it('signs the extension out too', async () => {
    installChrome({ [EXT]: extension() });
    renderApp('/app/settings', fakeAuth(PERMANENT).adapter, fetchImpl, fakeFeed([]).feed);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(sent.filter((s) => s.message.type === 'sign-out').map((s) => s.id)).toEqual([EXT, EDGE]));
  });
});

describe('the bridge', () => {
  it('reads only well-formed ids', () => {
    expect(extensionIdsFromEnv({ VITE_EXTENSION_IDS: ` ${EXT} ,nope,${EDGE.toUpperCase()}` })).toEqual([EXT]);
    expect(extensionIdsFromEnv({})).toEqual([]);
  });

  it('signing out of the web app signs every extension out', async () => {
    installChrome({ [EXT]: extension() });
    await signOutExtensions([EXT, EDGE]);
    await waitFor(() => expect(sent.map((s) => [s.id, s.message])).toEqual([[EXT, { type: 'sign-out' }], [EDGE, { type: 'sign-out' }]]));
  });
});
