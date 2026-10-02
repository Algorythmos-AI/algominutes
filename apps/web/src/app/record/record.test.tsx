import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { ApiProvider } from '../ApiContext';
import { AuthProvider } from '../auth/AuthContext';
import { NoticeProvider } from '../Notice';
import { NotesProvider } from '../notes/NotesContext';
import { RecordingStore } from '../../lib/recorder/store';
import { FakeRecorder, fakeLocks, fakeStream } from '../../test/fakeRecorder';
import { fakeAuth, PERMANENT } from '../../test/fakeAuth';
import { fakeFeed, ORIGINS } from '../../test/renderApp';
import { CALL_SILENT_WARN_MS, meterPercent, RecordPage, type RecorderEnv } from './RecordPage';
import type { CaptureEnv } from '../../lib/recorder/callCapture';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
  localStorage.clear();
});

const SESSION = { uploadId: 'u1', sessionUri: 'https://storage.googleapis.com/s', storagePath: 'recordings/workspace_u1/x.webm', chunkSize: 8388608, expiresAt: '2026-10-03T00:00:00Z' };
const ENT = { state: 'active', plan: 'free', billingPeriod: '2026-09', includedMinutes: 60, usedMinutes: 1, remainingMinutes: 59, overQuota: false };

function setup(over: Partial<RecorderEnv> = {}, config = { broadcastCapture: false }, routes: Record<string, () => Response> = {}) {
  const store = new RecordingStore(new IDBFactory());
  const mic = fakeStream();
  const { stream, stopped } = mic;
  const calls: string[] = [];
  const api = (async (url: RequestInfo | URL) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
    if (routes[path]) return routes[path]();
    if (path === '/v1/entitlement') return json(ENT);
    if (path === '/v1/config') return json(config);
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
  return { env, store, stopped, calls, writer, router, mic };
}

describe('the level meters', () => {
  it('fill on a decibel scale: a quiet room empty, speech about half, full scale full', () => {
    expect(meterPercent(0)).toBe(0);
    expect(meterPercent(0.001)).toBe(0);
    expect(Math.round(meterPercent(0.05))).toBe(57);
    expect(meterPercent(1)).toBe(100);
  });
});

describe('recording in the browser', () => {
  it("won't start until the permission box is ticked, as on iOS", async () => {
    const { env } = setup();
    const start = await screen.findByRole('button', { name: 'Tick the box to start' });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Start recording' })).toBeTruthy();
    expect(env.getUserMedia).not.toHaveBeenCalled();
  });

  it('with no minutes left, asks for the invite code before recording, and starts once it is redeemed', async () => {
    const none = { ...ENT, usedMinutes: 0, includedMinutes: 0, remainingMinutes: 0, overQuota: true };
    const redeemed = { entitlement: { ...ENT, plan: 'pro', includedMinutes: 600, usedMinutes: 0, remainingMinutes: 600 }, grantEndsAt: '2026-10-29T00:00:00.000Z', notetaker: false };
    const { env, calls } = setup({}, { broadcastCapture: false }, {
      '/v1/entitlement': () => new Response(JSON.stringify(none), { status: 200 }),
      '/v1/beta/redeem': () => new Response(JSON.stringify(redeemed), { status: 200 }),
    });
    fireEvent.click(await screen.findByRole('checkbox'));
    const start = await screen.findByRole('button', { name: 'Enter your invite code first' });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Invite code'), { target: { value: ' beta-7k2qx-m9d4r-tw8hn ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add minutes' }));
    expect(await screen.findByRole('button', { name: 'Start recording' })).toBeTruthy();
    expect(calls).toContain('/v1/beta/redeem');
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

  it('stops 5 seconds before the limit, so the recording measures inside it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    setup();
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await screen.findByText('● RECORDING');
    FakeRecorder.last!.emit('audio');
    vi.setSystemTime(start + (2 * 3600 - 4) * 1000);
    expect(await screen.findByRole('heading', { name: 'Opened' }, { timeout: 3000 })).toBeTruthy();
  });

  // RELEASE.md rev 11, N3 (H5b). The page started at the free plan's 2 hours, asked for the plan once, and on
  // a failure kept that cap for the whole visit: a Pro user's meeting was cut off at 2:00:00.
  it("a plan that couldn't be read doesn't stop a recording at 2 hours: the longest plan's cap holds until it's known", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    setup({ sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))) }, undefined, { '/v1/entitlement': () => new Response('{}', { status: 503 }) });
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await screen.findByText('● RECORDING');
    FakeRecorder.last!.emit('audio');
    // A minute before 2 hours: a page holding the free plan's cap warns that it stops at 2:00:00.
    vi.setSystemTime(start + (2 * 3600 - 60) * 1000);
    await new Promise((r) => setTimeout(r, 1200)); // the page's clock ticks every 500 ms
    expect(screen.getByText(/1:59:00/)).toBeTruthy();
    expect(screen.queryByText(/recording stops on its own at 2:00:00/)).toBeNull();
    expect(screen.getByText('● RECORDING')).toBeTruthy();
  });

  it('asks for the plan again after a failure, and then holds its cap', async () => {
    let answers = 0;
    const { calls } = setup({ sleep: async () => {} }, undefined, {
      '/v1/entitlement': () => (++answers === 1 ? new Response('{}', { status: 503 }) : new Response(JSON.stringify(ENT), { status: 200 })),
    });
    fireEvent.click(await screen.findByRole('checkbox'));
    await waitFor(() => expect(calls.filter((c) => c === '/v1/entitlement').length).toBeGreaterThanOrEqual(2));
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await screen.findByText('● RECORDING');
    FakeRecorder.last!.emit('audio');
    vi.setSystemTime(start + (2 * 3600 - 60) * 1000);
    expect(await screen.findByText(/left: recording stops on its own at 2:00:00/)).toBeTruthy();
  });

  // RELEASE.md rev 11, H6d: a recording past the minutes left is held, not lost; the page says so before and during.
  it('says the minutes left before recording, and when a recording passes them, that it will be kept', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    setup(); // ENT: 59 minutes left
    expect(await screen.findByText(/You have 59 recording minutes left this month/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await screen.findByText('● RECORDING');
    FakeRecorder.last!.emit('audio');
    expect(screen.queryByText(/longer than the minutes you have left/)).toBeNull();
    vi.setSystemTime(start + 60 * 60 * 1000); // an hour: past 59 minutes
    expect(await screen.findByText(/This recording is now longer than the minutes you have left this month\. It’s kept/)).toBeTruthy();
    expect(screen.getByText('● RECORDING')).toBeTruthy();
  });

  // RELEASE.md rev 11, N9: a sleeping laptop stops the microphone, and the screen wake lock can't stop a closed lid.
  it('while recording, says to keep the laptop awake', async () => {
    setup();
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await screen.findByText('● RECORDING');
    expect(screen.getByText(/closing the lid stops the recording/)).toBeTruthy();
  });

  // RELEASE.md rev 11, UX6: a microphone recording had no meter, so a dead or muted mic recorded silence unnoticed.
  describe('the microphone meter', () => {
    const micCtx = () => {
      const mic = { level: 0.2 };
      class Ctx {
        createMediaStreamSource() { return { connect() {} }; }
        createAnalyser() { return { fftSize: 4, connect() {}, getFloatTimeDomainData: (a: Float32Array) => a.fill(mic.level) }; }
        close() { return Promise.resolve(); }
      }
      return { mic, Ctx: Ctx as unknown as typeof AudioContext };
    };

    it('shows the microphone level while recording', async () => {
      const { Ctx } = micCtx();
      setup({ AudioContext: Ctx });
      fireEvent.click(await screen.findByRole('checkbox'));
      fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
      await screen.findByText('● RECORDING');
      const meter = await screen.findByRole('meter', { name: 'Your microphone' });
      await waitFor(() => expect(Number(meter.getAttribute('aria-valuenow'))).toBeGreaterThan(0));
    });

    it('a microphone silent for 30 seconds is said to be, and the warning goes when it hears something', async () => {
      const { mic, Ctx } = micCtx();
      mic.level = 0;
      vi.useFakeTimers({ toFake: ['Date'] });
      const start = Date.now();
      setup({ AudioContext: Ctx });
      fireEvent.click(await screen.findByRole('checkbox'));
      fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
      await screen.findByText('● RECORDING');
      await new Promise((r) => setTimeout(r, 600));
      vi.setSystemTime(start + 31_000);
      expect(await screen.findByText(/No sound from your microphone/, {}, { timeout: 2000 })).toBeTruthy();
      mic.level = 0.3;
      await waitFor(() => expect(screen.queryByText(/No sound from your microphone/)).toBeNull(), { timeout: 2000 });
    });
  });

  it('leaving the page while recording asks first, and keeps recording unless told to stop', async () => {
    setup();
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await screen.findByText('● RECORDING');
    // react-router registers the blocker in an effect after that render: let it run before leaving (a busy CI
    // runner once clicked first, and the navigation went through unblocked).
    await act(async () => {});
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
    await store.append('old', 0, new Blob(['left']), 125, Date.now() - 60_000);
    cleanup();
    setup({ store } as Partial<RecorderEnv>);
    expect(await screen.findByText(/2:05 \(cut off\)/)).toBeTruthy();
    // It exists only in this browser: Discard asks first (RELEASE.md rev 11, UX1), and Keep it leaves it.
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    const ask = await screen.findByRole('dialog', { name: 'Discard this recording?' });
    expect(ask.textContent).toMatch(/only in this browser/);
    fireEvent.click(within(ask).getByRole('button', { name: 'Keep it' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await store.list('u1')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Discard this recording?' })).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByText('A recording wasn’t uploaded')).toBeNull());
    expect(await store.list('u1')).toEqual([]);
  });

  // RELEASE.md rev 11, LM8: a failed or cut-off upload leaves its note (to resume into); discarding takes it too.
  it("discarding a recording whose upload left a note deletes that note too", async () => {
    const { store } = setup();
    await store.create({ id: 'old', uid: 'u1', mimeType: 'audio/webm', startedAt: Date.parse('2026-09-26T01:00:00Z'), seconds: 125 });
    await store.append('old', 0, new Blob(['left']), 125, Date.now() - 60_000);
    await store.setNote('old', { noteId: 'webkept', session: { uploadId: 'u1', sessionUri: 'https://s', chunkSize: 262144, storagePath: 'recordings/workspace_u1/webkept.webm', totalBytes: 4 } });
    cleanup();
    const second = setup({ store } as Partial<RecorderEnv>);
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Discard this recording?' })).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(second.calls).toContain('/v1/notes/delete'));
    expect(await store.list('u1')).toEqual([]);
  });

  describe('a call in another tab', () => {
    const track = () => Object.assign(new EventTarget(), { kind: 'audio', stop: vi.fn() });
    const captureEnv = () => {
      const tab = track();
      const mixed = { getTracks: () => [track()] } as unknown as MediaStream;
      // What each source's meter reads (RMS), and the microphone's mute.
      const level = { call: 0.1, mic: 0.1 };
      const gains: Array<{ gain: { value: number } }> = [];
      class Ctx extends EventTarget {
        state = 'running';
        private analysers = 0;
        createMediaStreamDestination() { return { stream: mixed }; }
        createMediaStreamSource() { return { connect() {} }; }
        // The call's meter is made first, then the microphone's.
        createAnalyser() { const which = this.analysers++ === 0 ? 'call' : 'mic'; return { fftSize: 4, connect() {}, getFloatTimeDomainData: (a: Float32Array) => a.fill(level[which]) }; }
        createGain() { const g = { gain: { value: 1 }, connect() {} }; gains.push(g); return g; }
        async resume() {}
        async close() {}
      }
      vi.stubGlobal('MediaStream', class { constructor(readonly tracks: unknown[]) {} });
      return {
        level,
        gains,
        tab,
        capture: {
          getDisplayMedia: vi.fn(async () => ({ getTracks: () => [tab], getAudioTracks: () => [tab] }) as unknown as MediaStream),
          getUserMedia: vi.fn(async () => { const m = track(); return { getTracks: () => [m], getAudioTracks: () => [m] } as unknown as MediaStream; }),
          AudioContext: Ctx as unknown as typeof AudioContext,
        },
      };
    };

    it('is offered only where the browser can and the switch is on', async () => {
      const { capture } = captureEnv();
      setup({ capture, canCaptureCalls: () => true }, { broadcastCapture: false });
      await screen.findByRole('checkbox');
      expect(screen.queryByLabelText('A call in another tab, with my microphone')).toBeNull();
      cleanup();
      setup({ capture, canCaptureCalls: () => false }, { broadcastCapture: true });
      await screen.findByRole('checkbox');
      expect(screen.queryByLabelText('A call in another tab, with my microphone')).toBeNull();
    });

    it("needs everyone's agreement too, records the call with the microphone, and the browser's Stop sharing saves it", async () => {
      const { capture, tab } = captureEnv();
      setup({ capture, canCaptureCalls: () => true }, { broadcastCapture: true });
      fireEvent.click(await screen.findByLabelText('A call in another tab, with my microphone'));
      fireEvent.click(screen.getByLabelText(/I have permission from anyone/));
      expect((screen.getByRole('button', { name: 'Tick the box to start' }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByLabelText('Everyone on the call has agreed to be recorded.'));
      fireEvent.click(screen.getByRole('button', { name: 'Choose the call’s tab' }));
      expect(await screen.findByText('● RECORDING')).toBeTruthy();
      expect(capture.getDisplayMedia).toHaveBeenCalledTimes(1);
      FakeRecorder.last!.emit('call audio');
      tab.dispatchEvent(new Event('ended'));
      expect(await screen.findByRole('heading', { name: 'Opened' })).toBeTruthy();
    });

    it('Stop sharing pressed while the recording starts still ends and saves it', async () => {
      const { capture, tab } = captureEnv();
      const { store } = setup({ capture, canCaptureCalls: () => true }, { broadcastCapture: true });
      const create = store.create.bind(store);
      store.create = async (m) => {
        tab.dispatchEvent(new Event('ended'));
        return create(m);
      };
      fireEvent.click(await screen.findByLabelText('A call in another tab, with my microphone'));
      fireEvent.click(screen.getByLabelText(/I have permission from anyone/));
      fireEvent.click(screen.getByLabelText('Everyone on the call has agreed to be recorded.'));
      fireEvent.click(screen.getByRole('button', { name: 'Choose the call’s tab' }));
      expect(await screen.findByRole('heading', { name: 'Opened' })).toBeTruthy();
    });

    const recordCall = async (capture: CaptureEnv) => {
      setup({ capture, canCaptureCalls: () => true }, { broadcastCapture: true });
      fireEvent.click(await screen.findByLabelText('A call in another tab, with my microphone'));
      fireEvent.click(screen.getByLabelText(/I have permission from anyone/));
      fireEvent.click(screen.getByLabelText('Everyone on the call has agreed to be recorded.'));
      fireEvent.click(screen.getByRole('button', { name: 'Choose the call’s tab' }));
      await screen.findByText('● RECORDING');
    };

    it('says the desktop apps on a Mac need the iPhone app', async () => {
      const { capture } = captureEnv();
      setup({ capture, canCaptureCalls: () => true }, { broadcastCapture: true });
      fireEvent.click(await screen.findByLabelText('A call in another tab, with my microphone'));
      expect(screen.getByText(/Zoom or Teams desktop apps on a Mac, record the call with the AlgoMinutes iPhone app/)).toBeTruthy();
    });

    it('meters the call and the microphone, and mutes the microphone in the recording', async () => {
      const { capture, gains, level } = captureEnv();
      level.call = 0.1;
      level.mic = 0.001;
      await recordCall(capture);
      const call = await screen.findByRole('meter', { name: 'The call' });
      expect(Number(call.getAttribute('aria-valuenow'))).toBeGreaterThan(50);
      expect(screen.getByRole('meter', { name: 'You' }).getAttribute('aria-valuenow')).toBe('0');
      fireEvent.click(screen.getByRole('button', { name: 'Mute my microphone' }));
      expect(gains[0].gain.value).toBe(0);
      expect(screen.getByRole('button', { name: 'Unmute my microphone' }).getAttribute('aria-pressed')).toBe('true');
      expect(await screen.findByRole('meter', { name: 'You (muted)' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Unmute my microphone' }));
      expect(gains[0].gain.value).toBe(1);
    });

    it('a call silent for a while is said to be, and the warning goes when it is heard', async () => {
      // Only the clock is faked: IndexedDB's own scheduling stays real.
      vi.useFakeTimers({ toFake: ['Date'] });
      const t0 = Date.now();
      const { capture, level } = captureEnv();
      level.call = 0;
      await recordCall(capture);
      await screen.findByRole('meter', { name: 'The call' });
      expect(screen.queryByText(/No sound from the call/)).toBeNull();
      vi.setSystemTime(t0 + CALL_SILENT_WARN_MS + 2000);
      expect(await screen.findByText(/No sound from the call for a while/, undefined, { timeout: 3000 })).toBeTruthy();
      level.call = 0.1;
      await waitFor(() => expect(screen.queryByText(/No sound from the call/)).toBeNull(), { timeout: 3000 });
    });

    it('a share without the tab’s sound says how to share it', async () => {
      const { capture } = captureEnv();
      capture.getDisplayMedia.mockResolvedValueOnce({ getTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream);
      setup({ capture, canCaptureCalls: () => true }, { broadcastCapture: true });
      fireEvent.click(await screen.findByLabelText('A call in another tab, with my microphone'));
      fireEvent.click(screen.getByLabelText(/I have permission from anyone/));
      fireEvent.click(screen.getByLabelText('Everyone on the call has agreed to be recorded.'));
      fireEvent.click(screen.getByRole('button', { name: 'Choose the call’s tab' }));
      expect((await screen.findByRole('alert')).textContent).toMatch(/Also share tab audio/);
    });
  });
});

const begin = async () => {
  fireEvent.click(await screen.findByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
  await screen.findByText('● RECORDING');
  FakeRecorder.last!.emit('audio');
};

describe('recording, when things go wrong', () => {
  it("never offers a recording another tab is still making (it would lose the rest of that meeting)", async () => {
    const { locks } = fakeLocks();
    const store = new RecordingStore(new IDBFactory());
    for (const id of ['live', 'left']) {
      await store.create({ id, uid: 'u1', mimeType: 'audio/webm', startedAt: Date.parse('2026-09-26T01:00:00Z'), seconds: 60 });
      await store.append(id, 0, new Blob(['a']), 60, Date.now() - 60_000);
    }
    // Another tab is recording "live": it holds its lock.
    void locks.request('algominutes-recording:live', () => new Promise(() => {}));
    setup({ store, locks });
    expect(await screen.findByText('A recording wasn’t uploaded')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Upload it' })).toHaveLength(1);
  });

  it('a microphone that goes away stops the recording, saves it, and says why', async () => {
    const { mic } = setup();
    await begin();
    mic.end();
    FakeRecorder.last!.stopOnItsOwn();
    expect(await screen.findByText(/The microphone stopped/)).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Opened' })).toBeTruthy();
  });

  it('leaving the page mid-recording (as signing out does) turns the microphone off and keeps the audio', async () => {
    const { store, stopped } = setup();
    await begin();
    cleanup();
    await waitFor(() => expect(stopped).toEqual(['track']));
    await waitFor(async () => expect((await store.list('u1'))[0]?.stoppedAt).toBeTypeOf('number'));
  });

  it('a second click on Upload does nothing: one note, one upload', async () => {
    const { store, calls } = setup();
    await store.create({ id: 'old', uid: 'u1', mimeType: 'audio/webm', startedAt: Date.parse('2026-09-26T01:00:00Z'), seconds: 60 });
    await store.append('old', 0, new Blob(['left']), 60, Date.now() - 60_000);
    cleanup();
    const again = setup({ store } as Partial<RecorderEnv>);
    const button = await screen.findByRole('button', { name: 'Upload it' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(await screen.findByRole('heading', { name: 'Opened' })).toBeTruthy();
    expect(again.calls.filter((c) => c === '/v1/uploads')).toHaveLength(1);
    void calls;
  });

  it('a tab closed mid-upload: the retry puts the audio into the note it left, not a second one', async () => {
    // The first upload never finishes: the tab is closed while it runs.
    const first = setup({ fetchImpl: (() => new Promise(() => {})) as typeof fetch });
    await begin();
    fireEvent.click(screen.getByRole('button', { name: 'Stop and save' }));
    await waitFor(async () => expect((await first.store.list('u1'))[0]?.note?.noteId).toMatch(/^web/));
    const [{ note }] = await first.store.list('u1');
    expect(first.writer.createNoteDoc).toHaveBeenCalledTimes(1);
    cleanup();
    const again = setup({ store: first.store } as Partial<RecorderEnv>);
    fireEvent.click(await screen.findByRole('button', { name: 'Upload it' }));
    expect(await screen.findByRole('heading', { name: 'Opened' })).toBeTruthy();
    expect(again.router.state.location.pathname).toBe(`/notes/${note!.noteId}`);
    // Its doc was written once, by the first upload: no second note.
    expect(again.writer.createNoteDoc).not.toHaveBeenCalled();
    expect(await first.store.list('u1')).toEqual([]);
  });

  it('closing the tab mid-upload asks first, as mid-recording does', async () => {
    setup({ fetchImpl: (() => new Promise(() => {})) as typeof fetch });
    await begin();
    const unload = () => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(unload()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Stop and save' }));
    expect(await screen.findByText(/Uploading your recording…/)).toBeTruthy();
    // The recording's guard is taken down as the upload's goes up: let those effects run first.
    await act(async () => {});
    expect(unload()).toBe(true);
  });

  it("a kickoff that fails after the upload is retried on the same note, never uploaded again", async () => {
    let refuse = true;
    const { store, calls, writer } = setup({}, undefined, { '/v1/process': () => (refuse ? new Response('{"error":"internal"}', { status: 500 }) : new Response(JSON.stringify({ success: true, noteId: 'n', jobId: 'j', status: 'queued' }), { status: 202 })) });
    await begin();
    fireEvent.click(screen.getByRole('button', { name: 'Stop and save' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/still saved in this browser/);
    const [meta] = await store.list('u1');
    expect(meta.kickoff?.noteId).toMatch(/^web/);
    refuse = false;
    fireEvent.click(await screen.findByRole('button', { name: 'Upload it' }));
    expect(await screen.findByRole('heading', { name: 'Opened' })).toBeTruthy();
    expect(calls.filter((c) => c === '/v1/uploads')).toHaveLength(1);
    expect(calls.filter((c) => c === '/v1/process')).toHaveLength(2);
    expect(writer.createNoteDoc).toHaveBeenCalledTimes(1);
    expect(await store.list('u1')).toEqual([]);
  });
});

