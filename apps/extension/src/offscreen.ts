// The offscreen document: it holds the media streams and records for the whole meeting, which a service
// worker can't (ADR 0002 §1). It records the meeting tab and the microphone, mixed, and uploads while it
// records (lib/stream-upload.ts). The tab's sound is also played back, since a captured tab is otherwise
// silent for the user. It hears only its own extension (sender.id) and messages addressed to it.
import { StreamUpload } from './lib/stream-upload';
import { idbTailStore } from './lib/tail-store';

const tails = idbTailStore();

interface Running {
  recorder: MediaRecorder;
  upload: StreamUpload;
  streams: MediaStream[];
  ctx: AudioContext;
  startedAt: number;
  micIncluded: boolean;
  failed: unknown;
}

let running: Running | null = null;

/** Chrome's legacy constraints for a tab-capture stream id: the only way to turn one into a stream. */
function tabConstraints(streamId: string): MediaStreamConstraints {
  return { audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }, video: false } as unknown as MediaStreamConstraints;
}

async function start(streamId: string, sessionUri: string, chunkSize: number, uploadId: string) {
  if (running) return { ok: false, error: 'busy' };
  const tab = await navigator.mediaDevices.getUserMedia(tabConstraints(streamId));
  let mic: MediaStream | null = null;
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (err) {
    // silent-catch-ok: no microphone (not allowed yet, or none) records the other people only, and the popup says so (micIncluded: false)
    void err;
  }
  const ctx = new AudioContext();
  const mix = ctx.createMediaStreamDestination();
  const tabSource = ctx.createMediaStreamSource(tab);
  tabSource.connect(mix);
  tabSource.connect(ctx.destination);
  if (mic) ctx.createMediaStreamSource(mic).connect(mix);

  const upload = new StreamUpload({
    sessionUri, fetch: (...a) => fetch(...a), maxChunk: chunkSize,
    // A copy of what Cloud Storage hasn't acknowledged, for recovery if the browser closes (37e).
    onTail: (tail) => {
      tails.put(uploadId, tail).catch((err: unknown) => {
        // silent-catch-ok: without the copy, a recording the browser closes on loses its last seconds only, as before 37e; the recording itself goes on
        void err;
      });
    },
  });
  const recorder = new MediaRecorder(mix.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 64_000 });
  const r: Running = { recorder, upload, streams: mic ? [tab, mic] : [tab], ctx, startedAt: Date.now(), micIncluded: !!mic, failed: null };
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    upload.push(e.data).catch((err: unknown) => {
      // The service worker stops and says so; the recording so far is lost only if the session is gone.
      r.failed = err;
      void chrome.runtime.sendMessage({ target: 'sw', type: 'upload-failed', error: err instanceof Error ? err.name : 'unknown' });
    });
  };
  // Closing the meeting's tab ends the capture: saved, as on the web.
  tab.getAudioTracks()[0]?.addEventListener('ended', () => void chrome.runtime.sendMessage({ target: 'sw', type: 'tab-ended' }));
  recorder.start(5_000);
  running = r;
  return { ok: true, micIncluded: r.micIncluded };
}

async function stop() {
  const r = running;
  if (!r) return { ok: false, error: 'not_recording' };
  running = null;
  const flushed = new Promise<void>((resolve) => r.recorder.addEventListener('stop', () => resolve(), { once: true }));
  if (r.recorder.state !== 'inactive') r.recorder.stop();
  await flushed;
  for (const s of r.streams) for (const t of s.getTracks()) t.stop();
  await r.ctx.close();
  if (r.failed) return { ok: false, error: 'upload_failed' };
  await r.upload.finish();
  return { ok: true, durationSec: Math.round((Date.now() - r.startedAt) / 1000), micIncluded: r.micIncluded };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const m = message as { target?: string; type?: string; streamId?: string; sessionUri?: string; chunkSize?: number; uploadId?: string };
  if (sender.id !== chrome.runtime.id || m?.target !== 'offscreen') return false;
  const work = m.type === 'start' && m.streamId && m.sessionUri && m.uploadId ? start(m.streamId, m.sessionUri, Number(m.chunkSize) || 8 * 1024 * 1024, m.uploadId)
    : m.type === 'stop' ? stop()
    : Promise.resolve({ ok: false, error: 'invalid' });
  work.then(sendResponse, (err: unknown) => sendResponse({ ok: false, error: 'capture_failed', detail: err instanceof Error ? err.name : 'unknown' }));
  return true;
});
