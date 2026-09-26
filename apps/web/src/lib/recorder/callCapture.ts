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
    // Video must be asked for too (browsers don't share audio alone); it's never recorded.
    display = await env.getDisplayMedia({ video: true, audio: { echoCancellation: false, noiseSuppression: false }, systemAudio: 'include', selfBrowserSurface: 'exclude' } as DisplayMediaStreamOptions);
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
  try {
    ctx = new Ctx();
    out = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(new MediaStream(display.getAudioTracks())).connect(out);
    ctx.createMediaStreamSource(mic).connect(out);
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
  return {
    stream: out.stream,
    sources: [...display.getAudioTracks(), ...mic.getAudioTracks()],
    onEnded: (cb) => listeners.push(cb),
    get ended() {
      return ended;
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      stopAll(display);
      stopAll(mic);
      out.stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch((err: unknown) => reportCrash('capture.closeMixer', err));
    },
  };
}
