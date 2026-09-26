import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { ApiProvider } from '../ApiContext';
import { AuthProvider } from '../auth/AuthContext';
import { NoticeProvider } from '../Notice';
import { NotesProvider } from '../notes/NotesContext';
import { RecordingStore } from '../../lib/recorder/store';
import { FakeRecorder, fakeStream } from '../../test/fakeRecorder';
import { fakeAuth, PERMANENT } from '../../test/fakeAuth';
import { fakeFeed, ORIGINS } from '../../test/renderApp';
import { RecordPage, type RecorderEnv } from './RecordPage';

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  localStorage.clear();
});

const SESSION = { uploadId: 'u1', sessionUri: 'https://storage.googleapis.com/s', storagePath: 'recordings/workspace_u1/x.webm', chunkSize: 8388608, expiresAt: '2026-10-03T00:00:00Z' };
const ENT = { state: 'active', plan: 'free', billingPeriod: '2026-09', includedMinutes: 60, usedMinutes: 1, remainingMinutes: 59, overQuota: false };

function setup(over: Partial<RecorderEnv> = {}) {
  const store = new RecordingStore(new IDBFactory());
  const { stream, stopped } = fakeStream();
  const calls: string[] = [];
  const api = (async (url: RequestInfo | URL) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
    if (path === '/v1/entitlement') return json(ENT);
    if (path === '/v1/uploads') return json(SESSION);
    if (path === '/v1/uploads/u1/complete') return json({ uploadId: 'u1', storagePath: SESSION.storagePath, complete: true });
    if (path === '/v1/process') return json({ success: true, noteId: 'n', jobId: 'j', status: 'queued' }, 202);
    return json({ ok: true });
  }) as typeof fetch;
  const writer = { createNoteDoc: vi.fn(async () => {}), markNoteFailed: vi.fn(async () => {}) };
  const env: RecorderEnv = {
    store,
    getUserMedia: vi.fn(async () => stream),
    Recorder: FakeRecorder as unknown as typeof MediaRecorder,
    isTypeSupported: (t) => t.startsWith('audio/webm'),
    fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch,
    ...over,
  };
  const router = createMemoryRouter([{ path: '/record', element: <RecordPage env={env} /> }, { path: '/notes/:id', element: <h1>Opened</h1> }, { path: '/', element: <h1>Notes</h1> }], { initialEntries: ['/record'] });
  render(
    <AuthProvider adapter={fakeAuth(PERMANENT).adapter}>
      <ApiProvider origins={ORIGINS} fetchImpl={api}>
        <NotesProvider feed={fakeFeed([]).feed} writer={writer}>
          <NoticeProvider>
            <RouterProvider router={router} />
          </NoticeProvider>
        </NotesProvider>
      </ApiProvider>
    </AuthProvider>,
  );
  return { env, store, stopped, calls, writer, router };
}

describe('recording in the browser', () => {
  it("won't start until the permission box is ticked, as on iOS", async () => {
    const { env } = setup();
    const start = await screen.findByRole('button', { name: 'Tick the box to start' });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Start recording' })).toBeTruthy();
    expect(env.getUserMedia).not.toHaveBeenCalled();
  });

  it('records, and Stop and save uploads it as a recording note, then opens it', async () => {
    const { store, stopped, writer, router } = setup();
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    expect(await screen.findByText('● RECORDING')).toBeTruthy();
    FakeRecorder.last!.emit('audio');
    fireEvent.click(screen.getByRole('button', { name: 'Stop and save' }));
    expect(await screen.findByRole('heading', { name: 'Opened' })).toBeTruthy();
    expect(writer.createNoteDoc).toHaveBeenCalledWith(expect.objectContaining({ type: 'recording', mimeType: 'audio/webm;codecs=opus', title: expect.stringMatching(/^Recording /) }));
    expect(router.state.location.pathname).toMatch(/^\/notes\/web/);
    expect(stopped).toEqual(['track']);
    // Uploaded and handed over: this browser's copy is gone.
    expect(await store.list('u1')).toEqual([]);
  });

  it("stops on its own at the plan's cap, with a warning before it, and saves", async () => {
    // Only the clock is faked: IndexedDB's own scheduling stays real.
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    setup();
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await screen.findByText('● RECORDING');
    FakeRecorder.last!.emit('audio');
    vi.setSystemTime(start + (2 * 3600 - 60) * 1000); // a minute before the free plan's 2 hours
    expect(await screen.findByText(/left: recording stops on its own at 2:00:00/)).toBeTruthy();
    vi.setSystemTime(start + 2 * 3600 * 1000 + 1000);
    expect(await screen.findByRole('heading', { name: 'Opened' }, { timeout: 3000 })).toBeTruthy();
  });

  it('leaving the page while recording asks first, and keeps recording unless told to stop', async () => {
    setup();
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await screen.findByText('● RECORDING');
    fireEvent.click(screen.getByRole('link', { name: '← Your notes' }));
    expect(await screen.findByRole('dialog', { name: 'You’re recording' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep recording' }));
    expect(screen.getByText('● RECORDING')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a microphone the user refused says how to allow it', async () => {
    setup({ getUserMedia: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } });
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/can’t use the microphone/);
  });

  it("a browser that can't record says so", async () => {
    setup({ isTypeSupported: () => false });
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/can’t record here/);
  });

  it("a failed upload keeps the recording on this browser, and it's offered again", async () => {
    const { store } = setup({ fetchImpl: (async () => { throw new TypeError('offline'); }) as typeof fetch, sleep: async () => {} });
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await screen.findByText('● RECORDING');
    FakeRecorder.last!.emit('audio');
    fireEvent.click(screen.getByRole('button', { name: 'Stop and save' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/still saved in this browser/);
    expect(await store.list('u1')).toHaveLength(1);
    expect(await screen.findByText('A recording wasn’t uploaded')).toBeTruthy();
  });

  it('a recording left by a closed tab can be uploaded or discarded', async () => {
    const { store } = setup();
    await store.create({ id: 'old', uid: 'u1', mimeType: 'audio/webm', startedAt: Date.parse('2026-09-26T01:00:00Z'), seconds: 125 });
    await store.append('old', 0, new Blob(['left']), 125);
    cleanup();
    setup({ store } as Partial<RecorderEnv>);
    expect(await screen.findByText(/2:05 \(cut off\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByText('A recording wasn’t uploaded')).toBeNull());
    expect(await store.list('u1')).toEqual([]);
  });
});
