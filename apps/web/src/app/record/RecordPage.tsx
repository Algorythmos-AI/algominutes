import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate } from 'react-router';
import { maxRecordingSecondsForPlan, RECORDING_LIMITS, type EntitlementResponse, type PlanId } from '@algominutes/contracts';
import { noMinutesLeft } from '../../lib/billing/invite';
import { reportCrash } from '../../lib/crashReport';
import { formatClock, formatDate } from '../../lib/notes/format';
import { canCaptureCalls, captureCall, CaptureError, meterStream, SILENT_LEVEL, type Capture, type CaptureEnv, type StreamMeter } from '../../lib/recorder/callCapture';
import { extensionFor, leftOver, pickMimeType, RecordingGoneError, startRecording, type ActiveRecording, type Locks } from '../../lib/recorder/recorder';
import type { RecordingMeta, RecordingStore } from '../../lib/recorder/store';
import { importAudio, retryKickoff, type ImportResult } from '../../lib/uploads/importAudio';
import { endedUpload, startedUpload } from '../../lib/uploads/ownUploads';
import { useApi } from '../ApiContext';
import { InviteCodeForm } from '../billing/InviteCodeForm';
import { useAuth } from '../auth/AuthContext';
import { Modal } from '../Modal';
import { useNotice } from '../Notice';
import { useNotes } from '../notes/NotesContext';
import { recorderEnv } from './env';

// Until the plan is known, a recording may run to the longest any plan allows: the server holds the real limit.
// Starting at the free plan's 2 hours, a Pro user whose plan couldn't be read was cut off at 2:00:00 (rev 11 N3).
const LONGEST_CAP_S = Math.max(...Object.values(RECORDING_LIMITS).map((l) => l.maxRecordingSeconds));
// It stops this far before the limit, so the audio it uploads measures inside it (rev 11 LM1).
const STOP_EARLY_S = 5;
// How long to wait before asking for the plan again after a failure: a few quick tries, then once a minute.
const PLAN_RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

export interface RecorderEnv {
  store: RecordingStore;
  getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>;
  Recorder?: typeof MediaRecorder;
  isTypeSupported?: (t: string) => boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Web Locks (undefined: the browser's; null: none, as in a browser without them). */
  locks?: Locks | null;
  /** Recording a call in another tab (W7): the browser's share, where it can share a tab's audio. */
  capture?: CaptureEnv;
  canCaptureCalls?: () => boolean;
  /** For the microphone meter (undefined: the browser's; tests pass a fake). */
  AudioContext?: typeof AudioContext;
}

type Phase =
  | { kind: 'consent' }
  | { kind: 'starting' }
  | { kind: 'denied' }
  | { kind: 'unsupported' }
  | { kind: 'recording'; startedAt: number }
  | { kind: 'saving'; fraction: number }
  | { kind: 'failed'; message: string };

const WARN_BEFORE_CAP_S = 5 * 60;
/** A call that's been silent this long is probably muted, or its tab was shared without its sound. */
export const CALL_SILENT_WARN_MS = 15_000;
// A microphone silent this long is said to be (rev 11, UX6): long enough for a pause, short enough to fix.
export const MIC_SILENT_WARN_MS = 30_000;

/** A meter's fill, on a decibel scale: -60 dB (a quiet room) is empty, full scale is full. */
export function meterPercent(level: number): number {
  if (level <= 0) return 0;
  return Math.max(0, Math.min(100, ((20 * Math.log10(level) + 60) / 60) * 100));
}

function LevelMeter({ label, level }: { label: string; level: number }) {
  const pct = Math.round(meterPercent(level));
  return (
    <div className="flex items-center gap-3">
      <span className="w-28 shrink-0 text-sm text-body">{label}</span>
      <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-2 flex-1 overflow-hidden rounded-full bg-border">
        <div className="h-2 rounded-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Holds the screen awake while recording (a sleeping laptop stops the microphone), where the browser can. */
function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let disposed = false;
    const acquire = () =>
      navigator.wakeLock.request('screen').then(
        (l) => {
          // Granted after recording stopped: let it go at once, or the screen stays on.
          if (disposed) void l.release().catch((err: unknown) => reportCrash('record.wakeLockRelease', err));
          else lock = l;
        },
        (err: unknown) => reportCrash('record.wakeLock', err),
      );
    void acquire();
    // A lock is released when the tab is hidden; take it again on return.
    const onVisible = () => document.visibilityState === 'visible' && void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch((err: unknown) => reportCrash('record.wakeLockRelease', err));
    };
  }, [active]);
}

/** Record a meeting in the browser: consent first, as on iOS; the audio is kept safe as it's made, then uploaded. */
export function RecordPage({ env = recorderEnv() }: { env?: RecorderEnv }) {
  const { user } = useAuth();
  const { api } = useApi();
  const { writer } = useNotes();
  const navigate = useNavigate();
  const notice = useNotice();
  const [phase, setPhase] = useState<Phase>({ kind: 'consent' });
  const [agreed, setAgreed] = useState(false);
  const [source, setSource] = useState<'mic' | 'call'>('mic');
  const [callAgreed, setCallAgreed] = useState(false);
  const [callsOn, setCallsOn] = useState(false);
  const capture = useRef<Capture | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [capSeconds, setCapSeconds] = useState(LONGEST_CAP_S);
  // A call's two sources, metered (RELEASE.md PR 13): null when not recording a call.
  const [levels, setLevels] = useState<{ call: number; mic: number } | null>(null);
  const [micMuted, setMicMuted] = useState(false);
  const [callSilent, setCallSilent] = useState(false);
  const silentSince = useRef<number | null>(null);
  // The microphone's meter when recording the microphone alone (a call's capture meters its own sources).
  const micMeter = useRef<StreamMeter | null>(null);
  const [micLevel, setMicLevel] = useState<number | null>(null);
  const [micSilent, setMicSilent] = useState(false);
  // A page left mid-recording closes the meter's audio context with it.
  useEffect(() => () => micMeter.current?.close(), []);
  // The server's minutes: with none left, the page asks for an invite code before a
  // recording the server would refuse (RELEASE.md PR 9). Unknown never blocks.
  const [ent, setEnt] = useState<EntitlementResponse | null>(null);
  const active = useRef<ActiveRecording | null>(null);
  // Set synchronously, so a second click (or Start) during the slow read of a long recording does nothing.
  const uploading = useRef(false);
  const capRef = useRef(capSeconds);
  const recording = phase.kind === 'recording';

  useEffect(() => {
    capRef.current = capSeconds;
  }, [capSeconds]);

  // Leaving the page with a recording running (signing out unmounts it too): the microphone goes off, and
  // what was recorded stays in this browser, offered for upload next time.
  useEffect(
    () => () => {
      const rec = active.current;
      active.current = null;
      rec?.stop().catch((err: unknown) => reportCrash('record.unmountStop', err));
      capture.current?.stop();
      capture.current = null;
    },
    [],
  );

  useWakeLock(recording);

  // A call's meters, read while it's recorded: a call silent for a while is said to be.
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => {
      const c = capture.current;
      const at = Date.now();
      if (!c) {
        const m = micMeter.current;
        if (!m) return;
        const level = m.level();
        setMicLevel(level);
        if (level >= SILENT_LEVEL) silentSince.current = null;
        else silentSince.current ??= at;
        setMicSilent(silentSince.current !== null && at - silentSince.current >= MIC_SILENT_WARN_MS);
        return;
      }
      const l = c.levels();
      setLevels(l);
      if (l.call >= SILENT_LEVEL) silentSince.current = null;
      else silentSince.current ??= at;
      setCallSilent(silentSince.current !== null && at - silentSince.current >= CALL_SILENT_WARN_MS);
    }, 500);
    return () => clearInterval(t);
  }, [recording]);
  // Leaving the page inside the app while recording would leave the microphone on with no Stop: ask first.
  const blocker = useBlocker(recording);

  // Calls in another tab: where the browser can share a tab's audio, and while the api's switch is on
  // (/v1/config broadcastCapture, the same kill switch as iOS's broadcast capture).
  const callsPossible = Boolean(env.capture) && (env.canCaptureCalls ?? canCaptureCalls)();
  useEffect(() => {
    if (!callsPossible) return;
    api.appConfig().then(
      (c) => setCallsOn(c.broadcastCapture),
      (err: unknown) => reportCrash('record.appConfig', err),
    );
  }, [api, callsPossible]);

  // The plan's per-recording cap, asked for until it's known (the longest plan's until then).
  useEffect(() => {
    let gone = false;
    const sleep = env.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    void (async () => {
      for (let attempt = 0; !gone; attempt++) {
        try {
          const e = await api.entitlement();
          if (gone) return;
          setEnt(e);
          setCapSeconds(maxRecordingSecondsForPlan(e.plan as PlanId));
          return;
        } catch (err) {
          // silent-catch-ok: the first failure is reported; the retries that follow are the handling (asked again until it answers), and reporting each would flood the crash beacon
          if (attempt === 0) reportCrash('record.entitlement', err);
          await sleep(PLAN_RETRY_MS[Math.min(attempt, PLAN_RETRY_MS.length - 1)]);
        }
      }
    })();
    return () => {
      gone = true;
    };
  }, [api, env.sleep]);

  // The clock while recording.
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [recording]);

  // A guard before the tab closes mid-recording or mid-upload. Nothing recorded is lost either way (it's in
  // this browser), but a closed upload has to start again, and its note waits in the list until it does.
  const saving = phase.kind === 'saving';
  useEffect(() => {
    if (!recording && !saving) return;
    const beforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [recording, saving]);

  const upload = useCallback(
    async (meta: RecordingMeta) => {
      if (uploading.current) return;
      if (!user || !writer) {
        setPhase({ kind: 'failed', message: 'Your recording is saved in this browser. Reload the page to upload it.' });
        return;
      }
      uploading.current = true;
      setPhase({ kind: 'saving', fraction: 0 });
      try {
        let result: ImportResult;
        if (meta.kickoff) {
          // Its audio is already uploaded: process that note, rather than uploading (and charging) again.
          result = await retryKickoff(api, meta.kickoff);
        } else {
          const blob = await env.store.blob(meta.id);
          if (!blob || blob.size === 0) {
            await env.store.remove(meta.id);
            setPhase({ kind: 'failed', message: 'That recording has no audio.' });
            return;
          }
          const file = new File([blob], `recording.${extensionFor(meta.mimeType)}`, { type: meta.mimeType });
          result = await importAudio(file, {
            api,
            uid: user.uid,
            recording: { title: `Recording ${formatDate(new Date(meta.startedAt).toISOString())}` },
            createNoteDoc: (n) => writer.createNoteDoc(n),
            markNoteFailed: (noteId, message) => writer.markNoteFailed(user.uid, noteId, message),
            probeDuration: async () => (meta.seconds > 0 ? meta.seconds : null),
            track: { start: startedUpload, end: endedUpload },
            // A tab closed mid-upload left its note: the audio goes into that one, not a second.
            reuseNoteId: meta.note?.noteId,
            onNote: (noteId) => env.store.setNote(meta.id, { noteId }),
            onNoteDropped: () => env.store.setNote(meta.id, undefined),
            fetchImpl: env.fetchImpl,
            sleep: env.sleep,
            onProgress: (fraction) => setPhase((p) => (p.kind === 'saving' ? { ...p, fraction } : p)),
          });
        }
        if (result.ok) {
          // Uploaded and handed to the server: this browser's copy goes, as iOS removes its own.
          await env.store.remove(meta.id);
          navigate(`/notes/${encodeURIComponent(result.noteId)}`);
        } else {
          if (result.kickoff) await env.store.setKickoff(meta.id, result.kickoff);
          setPhase({ kind: 'failed', message: `${result.message} Your recording is still saved in this browser.` });
        }
      } catch (err) {
        reportCrash('record.upload', err);
        setPhase({ kind: 'failed', message: 'Your recording couldn’t be uploaded. It’s still saved in this browser: upload it from the list above.' });
      } finally {
        uploading.current = false;
      }
    },
    [api, env, navigate, user, writer],
  );

  const stop = useCallback(async () => {
    const rec = active.current;
    if (!rec) return;
    active.current = null;
    try {
      await rec.stop();
      capture.current?.stop();
      capture.current = null;
      const meta = await env.store.get(rec.id);
      if (!meta) throw new RecordingGoneError();
      await upload(meta);
    } catch (err) {
      // silent-catch-ok: RecordingGoneError is another tab having taken the recording, and the page says so; anything else is reported
      if (err instanceof RecordingGoneError) {
        setPhase({ kind: 'failed', message: 'This recording was uploaded or discarded in another tab, so the rest of it couldn’t be saved.' });
      } else {
        reportCrash('record.stop', err);
        setPhase({ kind: 'failed', message: 'The recording couldn’t be saved. If it’s listed above, upload it from there.' });
      }
    } finally {
      // The shared tab and the mixer end with the recording, however it ended; so does the microphone's meter.
      capture.current?.stop();
      capture.current = null;
      micMeter.current?.close();
      micMeter.current = null;
      setMicLevel(null);
      setMicSilent(false);
    }
  }, [env.store, upload]);
  // The callbacks a running recording holds call the current stop, never the one from when it started.
  const stopRef = useRef(stop);
  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);

  // The cap: stop on its own at the plan's limit.
  const elapsed = recording ? Math.max(0, (now - phase.startedAt) / 1000) : 0;
  useEffect(() => {
    if (recording && elapsed >= capSeconds - STOP_EARLY_S) void stop();
  }, [recording, elapsed, capSeconds, stop]);

  const start = async () => {
    if (!user || uploading.current) return;
    const mimeType = pickMimeType(env.isTypeSupported);
    if (!mimeType || !env.getUserMedia) {
      setPhase({ kind: 'unsupported' });
      return;
    }
    setPhase({ kind: 'starting' });
    setLevels(null);
    setMicMuted(false);
    setCallSilent(false);
    setMicLevel(null);
    setMicSilent(false);
    micMeter.current?.close();
    micMeter.current = null;
    silentSince.current = null;
    let stream: MediaStream;
    if (source === 'call' && env.capture) {
      try {
        capture.current = await captureCall(env.capture);
        stream = capture.current.stream;
        // The browser's own "Stop sharing" ends the recording and saves it.
        capture.current.onEnded(() => void stopRef.current());
      } catch (err) {
        // silent-catch-ok: a cancelled share picker is the user's choice: back to the consent step
        if (err instanceof CaptureError && err.kind === 'cancelled') {
          setPhase({ kind: 'consent' });
          return;
        }
        setPhase({ kind: 'failed', message: err instanceof CaptureError ? err.message : 'The call couldn’t be recorded.' });
        return;
      }
    } else {
      try {
        stream = await env.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        micMeter.current = meterStream(stream, env.AudioContext ?? (typeof AudioContext === 'undefined' ? undefined : AudioContext));
      } catch (err) {
        // silent-catch-ok: getUserMedia's refusal is the user's permission or device, shown as denied or unsupported
        setPhase({ kind: (err as { name?: string })?.name === 'NotAllowedError' ? 'denied' : 'unsupported' });
        return;
      }
    }
    // Keep what's recorded even when storage runs short (best effort; the browser may say no).
    void navigator.storage?.persist?.().catch((err: unknown) => reportCrash('record.persist', err));
    try {
      active.current = await startRecording({
        id: `rec${crypto.randomUUID().replace(/-/g, '')}`,
        uid: user.uid,
        stream,
        store: env.store,
        mimeType,
        Recorder: env.Recorder,
        locks: env.locks,
        // A call's mix never ends by itself: watch what it's mixed from (the shared tab's audio, the microphone).
        watch: capture.current?.sources,
        onStoreError: (err) => {
          if (!(err instanceof RecordingGoneError)) reportCrash('record.store', err);
          void stopRef.current();
        },
        onInterrupted: () => {
          notice.show('The microphone stopped (it was disconnected, or its permission was taken away), so the recording was saved as it was.');
          void stopRef.current();
        },
        // Checked per chunk too: a hidden tab's clock is throttled, and the cap must still hold.
        onProgress: (seconds) => seconds >= capRef.current - STOP_EARLY_S && void stopRef.current(),
      });
      setNow(Date.now());
      setPhase({ kind: 'recording', startedAt: Date.now() });
      // "Stop sharing" pressed while the recording was starting: nothing was listening yet.
      if (capture.current?.ended) void stopRef.current();
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      capture.current?.stop();
      capture.current = null;
      reportCrash('record.start', err);
      setPhase({ kind: 'failed', message: 'Recording couldn’t start. Reload the page and try again.' });
    }
  };

  const left = capSeconds - elapsed;
  // The minutes this month's plan has left, when the server said (RELEASE.md rev 11, H6d). A recording that runs
  // past them isn't lost: it's held, uncharged, and processed when minutes arrive. Said before, and while, it does.
  const minutesLeft = ent?.remainingMinutes ?? null;
  const pastMinutes = minutesLeft != null && minutesLeft > 0 && elapsed > minutesLeft * 60;
  return (
    <section aria-labelledby="rec-title" className="flex max-w-xl flex-col gap-4">
      <p><Link to="/">← Your notes</Link></p>
      <h1 id="rec-title" className="text-3xl font-bold text-heading">Record a meeting</h1>
      <RecoveredRecordings env={env} busy={recording || phase.kind === 'saving'} onUpload={upload} />
      {phase.kind === 'failed' && <p role="alert" className="rounded-2xl border border-danger/40 bg-danger/10 p-4 text-body">{phase.message}</p>}

      {(phase.kind === 'consent' || phase.kind === 'failed') && (
        <div className="rounded-2xl border border-border bg-card p-5">
          <h2 className="mb-2 text-xl font-bold text-heading">Before you record</h2>
          <p className="text-body">
            AlgoMinutes records audio from this device for as long as you're recording. The audio is uploaded, then transcribed and summarised by Google Cloud's speech and AI services, and kept in your account until you delete it.
          </p>
          {callsOn && (
            <fieldset className="mt-4">
              <legend className="mb-1 text-body">Record</legend>
              <label className="flex gap-2 text-body">
                <input type="radio" name="source" checked={source === 'mic'} onChange={() => setSource('mic')} />
                This device’s microphone
              </label>
              <label className="flex gap-2 text-body">
                <input type="radio" name="source" checked={source === 'call'} onChange={() => setSource('call')} />
                A call in another tab, with my microphone
              </label>
            </fieldset>
          )}
          <label className="mt-4 flex gap-2 text-body">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            I have permission from anyone whose voice may be captured. If others are present, I'll let them know the meeting is being recorded.
          </label>
          {source === 'call' && (
            <label className="mt-2 flex gap-2 text-body">
              <input type="checkbox" checked={callAgreed} onChange={(e) => setCallAgreed(e.target.checked)} />
              Everyone on the call has agreed to be recorded.
            </label>
          )}
          {minutesLeft != null && minutesLeft > 0 && (
            <p className="mt-4 text-sm text-muted">
              You have {Math.floor(minutesLeft).toLocaleString('en-AU')} recording {Math.floor(minutesLeft) === 1 ? 'minute' : 'minutes'} left this month. A longer recording is kept, and processed when you have more.
            </p>
          )}
          {noMinutesLeft(ent) && (
            <div className="mt-4 rounded-xl border border-border bg-bg p-4">
              <p className="mb-3 text-body">You have no recording minutes left, so a recording couldn’t be processed. Enter the invite code from your invitation first.</p>
              <InviteCodeForm
                onRedeemed={(r) => {
                  setEnt(r.entitlement);
                  setCapSeconds(maxRecordingSecondsForPlan(r.entitlement.plan as PlanId));
                }}
              />
            </div>
          )}
          {(() => {
            const ready = agreed && (source === 'mic' || callAgreed) && !noMinutesLeft(ent);
            return (
              <button type="button" disabled={!ready} onClick={() => void start()} className="mt-4 rounded-xl bg-accent px-5 py-3 font-semibold text-white disabled:opacity-50">
                {ready ? (source === 'call' ? 'Choose the call’s tab' : 'Start recording') : noMinutesLeft(ent) ? 'Enter your invite code first' : 'Tick the box to start'}
              </button>
            );
          })()}
          <p className="mt-3 text-sm text-muted">
            {source === 'call'
              ? 'Your browser asks which tab to share: pick the call’s tab and tick “Also share tab audio”. Then it asks for the microphone, so your own voice is included.'
              : 'Your browser will ask to use the microphone.'}
          </p>
          {source === 'call' && (
            <p className="mt-2 text-sm text-muted">
              Only a call in a browser tab can be shared here (Google Meet, or Zoom and Teams in the browser). For the Zoom or Teams desktop apps on a Mac, record the call with the AlgoMinutes iPhone app.
            </p>
          )}
        </div>
      )}

      {phase.kind === 'starting' && <p role="status" className="text-muted">Starting the microphone…</p>}
      {phase.kind === 'denied' && (
        <p role="alert" className="rounded-2xl border border-border bg-card p-4 text-body">
          AlgoMinutes can’t use the microphone. Allow it for this site in your browser’s settings (the icon beside the address), then reload the page.
        </p>
      )}
      {phase.kind === 'unsupported' && (
        <p role="alert" className="rounded-2xl border border-border bg-card p-4 text-body">
          This browser can’t record here. Try a current version of Chrome, Edge, Firefox or Safari, or record in the AlgoMinutes app.
        </p>
      )}

      {recording && (
        <div role="status" className="rounded-2xl border border-danger/50 bg-card p-5 text-center">
          <p className="text-sm font-semibold tracking-wide text-danger">● RECORDING</p>
          <p className="mt-2 font-mono text-5xl text-heading" aria-label={`Recorded ${formatClock(elapsed * 1000)}`}>{formatClock(elapsed * 1000)}</p>
          {left <= WARN_BEFORE_CAP_S && <p className="mt-2 text-body">{formatClock(left * 1000)} left: recording stops on its own at {formatClock(capSeconds * 1000)}.</p>}
          {pastMinutes && (
            <p className="mt-2 text-body">
              This recording is now longer than the minutes you have left this month. It’s kept, and processed when you have minutes: add an invite code in Settings, or it runs when your minutes renew.
            </p>
          )}
          <p className="mt-2 text-sm text-muted">Keep this tab open. Everything recorded is saved in this browser as you go.</p>
          <p className="mt-1 text-sm text-muted">Keep your laptop awake and plugged in for a long meeting: closing the lid stops the recording.</p>
          {levels && (
            <div className="mt-4 flex flex-col gap-2 text-left">
              <LevelMeter label="The call" level={levels.call} />
              <LevelMeter label={micMuted ? 'You (muted)' : 'You'} level={levels.mic} />
              <button
                type="button"
                aria-pressed={micMuted}
                onClick={() => {
                  capture.current?.setMicMuted(!micMuted);
                  setMicMuted(!micMuted);
                }}
                className="mt-1 self-start rounded-lg border border-border px-3 py-1 text-sm text-heading"
              >
                {micMuted ? 'Unmute my microphone' : 'Mute my microphone'}
              </button>
            </div>
          )}
          {micLevel !== null && !levels && (
            <div className="mt-4 text-left">
              <LevelMeter label="Your microphone" level={micLevel} />
            </div>
          )}
          {micSilent && (
            <p role="alert" className="mt-3 rounded-xl border border-warning/50 bg-warning/10 p-3 text-left text-body">
              No sound from your microphone for 30 seconds. Check it isn’t muted, and that the right one is chosen in your browser’s site settings.
            </p>
          )}
          {callSilent && (
            <p role="alert" className="mt-3 rounded-xl border border-warning/50 bg-warning/10 p-3 text-left text-body">
              No sound from the call for a while. Check the call isn’t muted, and that its tab was shared with “Also share tab audio” ticked. If it wasn’t, stop and save, then record the call again.
            </p>
          )}
          <button type="button" onClick={() => void stop()} className="mt-4 rounded-xl bg-danger px-6 py-3 font-semibold text-white">Stop and save</button>
        </div>
      )}

      {blocker.state === 'blocked' && (
        <Modal title="You’re recording" onClose={() => blocker.reset()} initialFocus="[data-keep]">
          <p className="text-body">Stop and save the recording before you leave this page?</p>
          <div className="mt-4 flex flex-col gap-2">
            <button type="button" className="rounded-xl bg-danger px-4 py-3 font-semibold text-white" onClick={() => { blocker.reset(); void stop(); }}>Stop and save</button>
            <button type="button" data-keep className="py-2 text-muted" onClick={() => blocker.reset()}>Keep recording</button>
          </div>
        </Modal>
      )}

      {phase.kind === 'saving' && (
        <p role="status" className="rounded-2xl border border-border bg-card p-4 text-heading">Uploading your recording… {Math.round(phase.fraction * 100)}%. Keep this tab open until it’s done.</p>
      )}
    </section>
  );
}

/** Recordings left on this browser (a closed tab, a failed upload): upload them, or discard them. */
function RecoveredRecordings({ env, busy, onUpload }: { env: RecorderEnv; busy: boolean; onUpload: (m: RecordingMeta) => Promise<void> }) {
  const { user } = useAuth();
  const [left, setLeft] = useState<RecordingMeta[]>([]);
  const [discarding, setDiscarding] = useState<RecordingMeta | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!user || busy) return;
    let cancelled = false;
    // Never one still being made in another tab: uploading or discarding it would lose the rest of it.
    env.store
      .list(user.uid)
      .then((all) => leftOver(all, env.locks))
      .then(
        (l) => !cancelled && setLeft(l),
        (err: unknown) => reportCrash('record.listLeft', err),
      );
    return () => {
      cancelled = true;
    };
  }, [env.store, env.locks, user, busy, version]);
  if (busy || left.length === 0) return null;
  return (
    <div className="rounded-2xl border border-warning/50 bg-warning/10 p-4">
      <p className="font-semibold text-heading">{left.length === 1 ? 'A recording wasn’t uploaded' : `${left.length} recordings weren’t uploaded`}</p>
      <ul className="mt-2 flex flex-col gap-2">
        {left.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 text-body">
            <span>{formatDate(new Date(r.startedAt).toISOString())} · {formatClock(r.seconds * 1000)}{r.stoppedAt ? '' : ' (cut off)'}</span>
            <button type="button" className="rounded-lg bg-accent px-3 py-1 text-sm font-semibold text-white" onClick={() => void onUpload(r)}>Upload it</button>
            <button type="button" className="rounded-lg border border-border px-3 py-1 text-sm" onClick={() => setDiscarding(r)}>Discard</button>
          </li>
        ))}
      </ul>
      {discarding && (
        // It exists only in this browser, so a click that deleted it at once lost it for good (rev 11, UX1).
        <Modal title="Discard this recording?" onClose={() => setDiscarding(null)} initialFocus="[data-keep]">
          <p className="text-body">It’s only in this browser, so discarding deletes it for good.</p>
          <div className="mt-5 flex flex-wrap justify-end gap-3">
            <button type="button" data-keep className="rounded-lg border border-border px-4 py-2 text-heading" onClick={() => setDiscarding(null)}>Keep it</button>
            <button
              type="button"
              className="rounded-lg bg-danger px-4 py-2 font-semibold text-white"
              onClick={() => {
                const r = discarding;
                setDiscarding(null);
                void env.store.remove(r.id).then(() => setVersion((v) => v + 1), (err: unknown) => reportCrash('record.discard', err));
              }}
            >
              Discard
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
