import { describe, expect, it, vi } from 'vitest';
import { canCaptureCalls, captureCall, CaptureError, levelOf } from './callCapture';

class FakeTrack extends EventTarget {
  stopped = false;
  readyState: 'live' | 'ended' = 'live';
  constructor(readonly kind: 'audio' | 'video') { super(); }
  stop() { this.stopped = true; }
}
const stream = (...tracks: FakeTrack[]) => ({ getTracks: () => tracks, getAudioTracks: () => tracks.filter((t) => t.kind === 'audio') }) as unknown as MediaStream;

class FakeNode {
  targets: unknown[] = [];
  connect(n: unknown) { this.targets.push(n); return n; }
}
class FakeAnalyser extends FakeNode {
  fftSize = 8;
  level = 0;
  getFloatTimeDomainData(a: Float32Array) { a.fill(this.level); }
}
class FakeGain extends FakeNode { gain = { value: 1 }; }
class FakeCtx extends EventTarget {
  static last: FakeCtx;
  sources: Array<{ stream: unknown; node: FakeNode }> = [];
  analysers: FakeAnalyser[] = [];
  gains: FakeGain[] = [];
  state: AudioContextState = 'running';
  resumes = 0;
  closed = false;
  out = { stream: stream(new FakeTrack('audio')) };
  constructor() { super(); FakeCtx.last = this; }
  createMediaStreamDestination() { return this.out; }
  createMediaStreamSource(s: unknown) { const node = new FakeNode(); this.sources.push({ stream: s, node }); return node; }
  createAnalyser() { const a = new FakeAnalyser(); this.analysers.push(a); return a; }
  createGain() { const g = new FakeGain(); this.gains.push(g); return g; }
  async resume() { this.resumes += 1; this.state = 'running'; }
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
    // The call straight into the mix; the microphone through its mute.
    const [call, mic] = FakeCtx.last.sources;
    const [gain] = FakeCtx.last.gains;
    expect(call.node.targets).toContain(FakeCtx.last.out);
    expect(mic.node.targets).toEqual([gain]);
    expect(gain.targets).toContain(FakeCtx.last.out);
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
      createMediaStreamSource(): FakeNode {
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

describe('a call capture you can trust', () => {
  const start = async (display = vi.fn(async () => stream(new FakeTrack('video'), new FakeTrack('audio')))) => {
    const c = await captureCall({ getDisplayMedia: display, getUserMedia: async () => stream(new FakeTrack('audio')), AudioContext: FakeCtx as unknown as typeof AudioContext });
    const [callMeter, micMeter] = FakeCtx.last.analysers;
    return { c, ctx: FakeCtx.last, callMeter, micMeter, display };
  };

  it('meters the call and the microphone separately', async () => {
    const { c, callMeter, micMeter } = await start();
    callMeter.level = 0.25;
    micMeter.level = 0;
    expect(c.levels()).toEqual({ call: 0.25, mic: 0 });
    expect(levelOf({ fftSize: 4, getFloatTimeDomainData: (a: Float32Array) => a.set([1, -1, 1, -1]) })).toBe(1);
  });

  it('mutes the microphone in the recording, and its meter reads what is recorded', async () => {
    const { c, ctx, micMeter } = await start();
    const [gain] = ctx.gains;
    // The meter is after the mute: it hears what the recording hears.
    expect(gain.targets).toContain(micMeter);
    c.setMicMuted(true);
    expect([gain.gain.value, c.micMuted]).toEqual([0, true]);
    c.setMicMuted(false);
    expect([gain.gain.value, c.micMuted]).toEqual([1, false]);
  });

  it('starts the mixer again whenever the browser suspends it, until it is stopped', async () => {
    const { c, ctx } = await start();
    ctx.state = 'suspended';
    ctx.dispatchEvent(new Event('statechange'));
    expect(ctx.resumes).toBe(1);
    c.stop();
    ctx.state = 'suspended';
    ctx.dispatchEvent(new Event('statechange'));
    expect(ctx.resumes).toBe(1);
  });

  it("asks for the tab's video small and at one frame a second: it's never recorded", async () => {
    const { display } = await start();
    const asked = (display.mock.calls[0] as unknown as [DisplayMediaStreamOptions])[0];
    expect(asked.video).toEqual({ frameRate: { max: 1 }, width: { max: 320 }, height: { max: 180 } });
    expect(asked.audio).toBeTruthy();
  });
});
