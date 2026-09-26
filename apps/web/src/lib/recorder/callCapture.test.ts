import { describe, expect, it, vi } from 'vitest';
import { canCaptureCalls, captureCall, CaptureError } from './callCapture';

class FakeTrack extends EventTarget {
  stopped = false;
  readyState: 'live' | 'ended' = 'live';
  constructor(readonly kind: 'audio' | 'video') { super(); }
  stop() { this.stopped = true; }
}
const stream = (...tracks: FakeTrack[]) => ({ getTracks: () => tracks, getAudioTracks: () => tracks.filter((t) => t.kind === 'audio') }) as unknown as MediaStream;

class FakeCtx {
  static last: FakeCtx;
  connected: unknown[] = [];
  closed = false;
  out = { stream: stream(new FakeTrack('audio')) };
  constructor() { FakeCtx.last = this; }
  createMediaStreamDestination() { return this.out; }
  createMediaStreamSource(s: unknown) { return { connect: () => this.connected.push(s) }; }
  async close() { this.closed = true; }
}
// jsdom has no MediaStream: a stand-in that just holds its tracks.
vi.stubGlobal('MediaStream', class { constructor(readonly tracks: unknown[]) {} });

describe('capturing a call in another tab', () => {
  it("mixes the tab's audio with the microphone, and stopping ends the share, the microphone and the mixer", async () => {
    const tabAudio = new FakeTrack('audio');
    const tabVideo = new FakeTrack('video');
    const micTrack = new FakeTrack('audio');
    const c = await captureCall({ getDisplayMedia: async () => stream(tabVideo, tabAudio), getUserMedia: async () => stream(micTrack), AudioContext: FakeCtx as unknown as typeof AudioContext });
    expect(FakeCtx.last.connected).toHaveLength(2);
    expect(c.stream).toBe(FakeCtx.last.out.stream);
    c.stop();
    expect([tabAudio.stopped, tabVideo.stopped, micTrack.stopped, FakeCtx.last.closed]).toEqual([true, true, true, true]);
  });

  it("the browser's Stop sharing tells the recording to end", async () => {
    const tabAudio = new FakeTrack('audio');
    const c = await captureCall({ getDisplayMedia: async () => stream(new FakeTrack('video'), tabAudio), getUserMedia: async () => stream(new FakeTrack('audio')), AudioContext: FakeCtx as unknown as typeof AudioContext });
    const ended = vi.fn();
    c.onEnded(ended);
    tabAudio.dispatchEvent(new Event('ended'));
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('a share with no sound, a cancelled share and a refused microphone each say so, leaving nothing on', async () => {
    const video = new FakeTrack('video');
    await expect(captureCall({ getDisplayMedia: async () => stream(video), getUserMedia: async () => stream(), AudioContext: FakeCtx as unknown as typeof AudioContext })).rejects.toMatchObject({ kind: 'no_audio' });
    expect(video.stopped).toBe(true);
    await expect(captureCall({ getDisplayMedia: async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); }, getUserMedia: async () => stream() })).rejects.toMatchObject({ kind: 'cancelled' });
    const tabAudio = new FakeTrack('audio');
    await expect(captureCall({ getDisplayMedia: async () => stream(tabAudio), getUserMedia: async () => { throw new Error('denied'); } })).rejects.toBeInstanceOf(CaptureError);
    expect(tabAudio.stopped).toBe(true);
  });

  it('only desktop Chromium can', () => {
    const nav = (brands: string[], mobile = false, gdm = true) => ({ mediaDevices: gdm ? { getDisplayMedia: () => {} } : {}, userAgentData: { brands: brands.map((brand) => ({ brand })), mobile } }) as unknown as Navigator;
    expect(canCaptureCalls(nav(['Chromium', 'Google Chrome']))).toBe(true);
    expect(canCaptureCalls(nav(['Chromium'], true))).toBe(false);
    expect(canCaptureCalls(nav(['Chromium'], false, false))).toBe(false);
    expect(canCaptureCalls({ mediaDevices: { getDisplayMedia: () => {} } } as unknown as Navigator)).toBe(false); // Safari, Firefox: no userAgentData
  });

  it("if the mixer can't be built, the share and the microphone are turned off", async () => {
    const tabAudio = new FakeTrack('audio');
    const micTrack = new FakeTrack('audio');
    class BrokenCtx extends FakeCtx {
      createMediaStreamSource(): { connect: () => number } {
        throw new DOMException('no', 'NotSupportedError');
      }
    }
    await expect(captureCall({ getDisplayMedia: async () => stream(tabAudio), getUserMedia: async () => stream(micTrack), AudioContext: BrokenCtx as unknown as typeof AudioContext })).rejects.toMatchObject({ kind: 'failed' });
    expect(tabAudio.stopped && micTrack.stopped).toBe(true);
    expect(FakeCtx.last.closed).toBe(true);
  });

  it('knows its sources, and a share that ended during the microphone prompt counts as ended', async () => {
    const tabAudio = new FakeTrack('audio');
    const micTrack = new FakeTrack('audio');
    const c = await captureCall({
      getDisplayMedia: async () => stream(tabAudio),
      getUserMedia: async () => {
        tabAudio.readyState = 'ended';
        return stream(micTrack);
      },
      AudioContext: FakeCtx as unknown as typeof AudioContext,
    });
    expect(c.sources).toEqual([tabAudio, micTrack]);
    expect(c.ended).toBe(true);
  });
});
