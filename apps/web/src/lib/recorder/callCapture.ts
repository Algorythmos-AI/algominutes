import { reportCrash } from '../crashReport';

// Recording a call in another tab: the browser's tab (or screen) share, taking
// its audio only, mixed with the microphone, so both sides are in the
// recording. The web twin of iOS's broadcast capture. Chromium desktop only:
// Safari can't share a tab's audio, and Firefox shares no audio at all.

export class CaptureError extends Error {
  constructor(readonly kind: 'no_audio' | 'cancelled' | 'mic_denied' | 'failed', message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CaptureError';
  }
}

export interface CaptureEnv {
  getDisplayMedia: (c: DisplayMediaStreamOptions) => Promise<MediaStream>;
  getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>;
  AudioContext?: typeof AudioContext;
}

export interface Capture {
  /** The call and the microphone, mixed: what gets recorded. */
  stream: MediaStream;
  /** The tracks captured from (the call's audio, the microphone): when one ends, nothing more of it is recorded. */
  sources: MediaStreamTrack[];
  /** Called when the user ends the share from the browser's own bar. */
  onEnded(cb: () => void): void;
  /** Whether the share has already ended (perhaps before anyone was listening). */
  readonly ended: boolean;
  /** Stops the share, the microphone and the mixer. */
  stop(): void;
  /** How loud the call and the microphone are right now, 0 (silence) to 1: for the meters, and the silence warning. */
  levels(): { call: number; mic: number };
  /** Mutes the microphone in the recording (the call is still recorded), or unmutes it. */
  setMicMuted(muted: boolean): void;
  readonly micMuted: boolean;
}

/** Below this, a source is silent (RMS: speech at a normal level is well above 0.02). */
export const SILENT_LEVEL = 0.005;

/** How loud a source is right now, 0 to 1: the RMS of the analyser's latest samples. */
export function levelOf(analyser: Pick<AnalyserNode, 'fftSize' | 'getFloatTimeDomainData'>): number {
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (const v of samples) sum += v * v;
  return Math.min(1, Math.sqrt(sum / samples.length));
}

/** Whether this browser can capture another tab's audio: desktop Chromium. */
export function canCaptureCalls(nav: Navigator = navigator): boolean {
  if (typeof nav.mediaDevices?.getDisplayMedia !== 'function') return false;
  const ua = (nav as Navigator & { userAgentData?: { brands?: Array<{ brand: string }>; mobile?: boolean } }).userAgentData;
  return Boolean(ua && !ua.mobile && ua.brands?.some((b) => b.brand === 'Chromium'));
}

export async function captureCall(env: CaptureEnv): Promise<Capture> {
  let display: MediaStream;
  try {
    // Video must be asked for too (browsers don't share audio alone). It's never recorded, so it's asked for
    // small and at one frame a second: a full-rate share of a video call costs the laptop for nothing.
    display = await env.getDisplayMedia({ video: { frameRate: { max: 1 }, width: { max: 320 }, height: { max: 180 } }, audio: { echoCancellation: false, noiseSuppression: false }, systemAudio: 'include', selfBrowserSurface: 'exclude' } as DisplayMediaStreamOptions);
  } catch (err) {
    const name = (err as { name?: string })?.name;
    throw new CaptureError(name === 'NotAllowedError' ? 'cancelled' : 'failed', name === 'NotAllowedError' ? 'The share was cancelled.' : 'The call couldn’t be shared.', { cause: err });
  }
  const stopAll = (s: MediaStream) => s.getTracks().forEach((t) => t.stop());
  if (display.getAudioTracks().length === 0) {
    stopAll(display);
    throw new CaptureError('no_audio', 'That share has no sound. Share the call’s tab and tick “Also share tab audio”.');
  }
  let mic: MediaStream;
  try {
    mic = await env.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (err) {
    stopAll(display);
    throw new CaptureError('mic_denied', 'AlgoMinutes needs the microphone too, so your own voice is in the recording.', { cause: err });
  }
  const Ctx = env.AudioContext ?? AudioContext;
  let ctx: AudioContext | null = null;
  let out: MediaStreamAudioDestinationNode;
  // Each source is metered on its own, so the page can say which one is silent. The microphone goes through a
  // gain, its mute; its meter is after it, so a muted microphone reads as silent.
  let callMeter: AnalyserNode;
  let micMeter: AnalyserNode;
  let micGain: GainNode;
  try {
    ctx = new Ctx();
    out = ctx.createMediaStreamDestination();
    const call = ctx.createMediaStreamSource(new MediaStream(display.getAudioTracks()));
    callMeter = ctx.createAnalyser();
    call.connect(out);
    call.connect(callMeter);
    micGain = ctx.createGain();
    micMeter = ctx.createAnalyser();
    ctx.createMediaStreamSource(mic).connect(micGain);
    micGain.connect(out);
    micGain.connect(micMeter);
  } catch (err) {
    // No mixer, no recording: the share and the microphone must not stay on.
    stopAll(display);
    stopAll(mic);
    ctx?.close().catch((closeErr: unknown) => reportCrash('capture.closeMixer', closeErr));
    throw new CaptureError('failed', 'The call couldn’t be recorded.', { cause: err });
  }

  const listeners: Array<() => void> = [];
  let ended = false;
  // The browser's "Stop sharing" ends the display's tracks.
  for (const t of display.getTracks()) {
    t.addEventListener(
      'ended',
      () => {
        if (ended) return;
        ended = true;
        listeners.forEach((cb) => cb());
      },
      { once: true },
    );
  }
  // Ended before anyone listened (during the microphone prompt): say so from the start.
  if (display.getAudioTracks().some((t) => t.readyState === 'ended')) ended = true;
  let stopped = false;
  let micMuted = false;
  // A suspended mixer records silence, and Chrome can suspend one (an audio device change, the system taking
  // the audio session): start it again whenever it stops, until the recording does.
  const mixer = ctx;
  const resume = () => {
    if (stopped || mixer.state !== 'suspended') return;
    mixer.resume().catch((err: unknown) => reportCrash('capture.resumeMixer', err));
  };
  mixer.addEventListener('statechange', resume);
  resume();
  return {
    stream: out.stream,
    sources: [...display.getAudioTracks(), ...mic.getAudioTracks()],
    onEnded: (cb) => listeners.push(cb),
    get ended() {
      return ended;
    },
    levels: () => ({ call: levelOf(callMeter), mic: levelOf(micMeter) }),
    setMicMuted: (muted) => {
      micMuted = muted;
      micGain.gain.value = muted ? 0 : 1;
    },
    get micMuted() {
      return micMuted;
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      stopAll(display);
      stopAll(mic);
      out.stream.getTracks().forEach((t) => t.stop());
      mixer.removeEventListener('statechange', resume);
      mixer.close().catch((err: unknown) => reportCrash('capture.closeMixer', err));
    },
  };
}
