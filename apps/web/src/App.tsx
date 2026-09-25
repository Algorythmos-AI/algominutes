import React, { useState, useEffect, useRef } from 'react';
import {
  Mic,
  Plus,
  Bot,
  Scan,
  Home,
  Folder,
  Users,
  Settings,
  ChevronLeft,
  FileText,
  Download,
  Square,
  ChevronRight,
  RotateCcw,
  Search,
  MessageSquare,
  X,
  Pencil,
  Check,
  Trash2,
  AlertCircle,
  LifeBuoy,
  Flag,
} from 'lucide-react';
import SearchTab from './components/SearchTab';
import ChatTab from './components/ChatTab';
import ImportPanel from './components/ImportPanel';
import ScanPanel from './components/ScanPanel';
import YouTubeImport from './components/YouTubeImport';
import EqualizerBg from './components/EqualizerBg';
import JobStatus from './components/JobStatus';
import Waveform from './components/Waveform';
import { authedFetch, setAuthExpiredHandler, setQuotaExceededHandler } from './lib/authedFetch';
import SurfaceBoundary from './components/SurfaceBoundary';
import { markNoteError } from './lib/noteStatus';
import { watchdogPass } from './lib/noteWatchdog';
import { draftFromNote, saveNoteEdits, renameNote, type EditableNoteFields } from './lib/noteEdit';
import { motion, AnimatePresence } from 'motion/react';
import { Capacitor } from './lib/native-shim/core';
import { Camera, CameraResultType, CameraSource } from './lib/native-shim/plugins';
import { FirebaseAuthentication } from './lib/native-shim/plugins';
import { Directory, Filesystem } from './lib/native-shim/plugins';
import { Share } from './lib/native-shim/plugins';
import BackgroundRecorder from './plugins/BackgroundRecorder';
import BroadcastRecorder, { type BroadcastState } from './plugins/BroadcastRecorder';
import BroadcastInstructionSheet from './components/BroadcastInstructionSheet';
import InstantRecorderConsent from './components/InstantRecorderConsent';
import DeleteAccountConfirmation from './components/DeleteAccountConfirmation';
import PrivacyPolicy from './pages/PrivacyPolicy';
import TermsOfService from './pages/TermsOfService';
import DeleteAccount from './pages/DeleteAccount';
import SharedNote from './pages/SharedNote';
import Paywall, { TrialBanner, type PaywallContext } from './components/Paywall';
import AccountPrompt from './components/AccountPrompt';
import HelpSupportSheet from './components/HelpSupportSheet';
import RetentionSetting from './components/RetentionSetting';
import { signInErrorMessage } from './lib/authErrors';
import { reportCrash } from './lib/crashReport';
import { fetchEntitlement, track } from './lib/billing';
import { acceptTerms, type SupportKind } from './lib/compliance';
import { TERMS_VERSION, PRIVACY_VERSION } from '@algominutes/contracts';
import { upgradeGuestWithGoogle, upgradeGuestWithApple } from './lib/guestAuth';
import type { EntitlementResponse } from '@algominutes/contracts';
import AdminCostsCard from './components/AdminCostsCard';
import { isAdmin } from './lib/admin';
import { recognizeText } from './lib/ocr';
import { extractTextFromFile } from './lib/documentText';
import { imagesToPdfBlob } from './lib/imagePdf';
import { auth, db, storage, ensureAnonymousIdentity } from './firebase';
import { ref, uploadBytes, uploadBytesResumable } from 'firebase/storage';
import type { User } from 'firebase/auth';
import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithCredential,
  GoogleAuthProvider,
  OAuthProvider,
  signOut,
} from 'firebase/auth';
import {
  collection,
  query,
  where,
  onSnapshot,
  doc,
  getDoc,
  setDoc,
  runTransaction,
  updateDoc,
} from 'firebase/firestore';
import type { Note, NoteType, Summary } from './types';
import { DEFAULT_MAX_RECORDING_SECONDS } from '@algominutes/contracts';
import { readErrorText } from './lib/http';

// Per-recording cap is plan-derived config (A6.2), defined once in
// @algominutes/contracts. Until entitlements resolve (A9), the web client uses
// the default-tier cap. TODO(A9): read the signed-in user's plan cap.
const MAX_RECORDING_SECONDS = DEFAULT_MAX_RECORDING_SECONDS;

/**
 * Copy for the approaching-cap banner.
 *
 * Derived from MAX_RECORDING_SECONDS rather than written out: the banner used
 * to read "…s left — AlgoMinutes auto-stops at 60:00" while the cap had been two
 * hours, so it was both raw seconds and wrong by a factor of two. Mirrors
 * RecordingView.capWarning on iOS.
 */
function capWarningText(secondsLeft: number): string {
  const minutes = Math.ceil(secondsLeft / 60);
  const left = minutes <= 1 ? 'Less than a minute' : `About ${minutes} minutes`;
  const capHours = MAX_RECORDING_SECONDS / 3600;
  return `${left} left — recording stops automatically at ${capHours} hours`;
}
const RECORDING_WARN_AFTER_SECONDS = 55 * 60; // surface auto-stop warning at 55:00

// Pre-summary placeholder titles look like "Session_2026-05-09" /
// "Import_2026-05-09". Used by the auto-retitle effect to recognise
// notes that should pick up a real title once the summary lands.
const PLACEHOLDER_TITLE_RE = /^(Session|Import)_\d{4}-\d{2}-\d{2}$/;

// Derive a short note title from the summary's executive gist:
// take the first sentence, strip trailing punctuation, cap at 80 chars.
// Returns null if there's nothing usable.
function deriveTitleFromSummary(summary: Summary | undefined): string | null {
  const gist = summary?.gist;
  if (!gist || typeof gist !== 'string') return null;
  const trimmed = gist.trim();
  if (!trimmed) return null;
  // Split on sentence-end punctuation; first chunk is the headline.
  const firstSentence = trimmed.split(/(?<=[.!?])\s+/)[0]?.trim();
  if (!firstSentence) return null;
  const noTrailing = firstSentence.replace(/[.!?]+$/, '').trim();
  if (!noTrailing) return null;
  const MAX = 80;
  if (noTrailing.length <= MAX) return noTrailing;
  // Cut at the last word break before the cap so we don't slice mid-word.
  const slice = noTrailing.slice(0, MAX);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > 40 ? slice.slice(0, lastSpace) : slice).trim() + '…';
}

// ─── helpers ──────────────────────────────────────────────────
const workspaceId = (uid: string) => `workspace_${uid}`;

type StaticPage = 'privacy' | 'terms' | 'delete-account' | null;
const pathnameToStaticPage = (path: string): StaticPage =>
  path === '/privacy'
    ? 'privacy'
    : path === '/terms'
    ? 'terms'
    : path === '/delete-account'
    ? 'delete-account'
    : null;

// A share link is /s/<token>. Read straight from the URL rather than held in
// state: unlike Privacy and Terms there is no in-app navigation to it — the
// only way here is following a link someone sent, so the pathname is the
// single source of truth and never changes while the page is open.
const shareTokenFromPath = (path: string): string | null => {
  const m = /^\/s\/([A-Za-z0-9_-]{20,200})\/?$/.exec(path);
  return m ? m[1] : null;
};

export default function App() {
  // Static legal pages: initial value comes from the URL, so an App Store
  // reviewer hitting https://algominutes.com/privacy lands directly
  // on the page. In-app navigation from Settings/login flips this state
  // without reloading the WKWebView (Capacitor would otherwise treat
  // <a href="/privacy"> as a full page navigation, killing in-memory
  // state). All hooks below run unconditionally so hooks order is stable.
  const [staticPage, setStaticPage] = useState<StaticPage>(() =>
    typeof window !== 'undefined' ? pathnameToStaticPage(window.location.pathname) : null,
  );

  const showStaticPage = (page: StaticPage) => {
    setStaticPage(page);
    if (typeof window !== 'undefined' && page) {
      try {
        window.history.pushState({ staticPage: page }, '', `/${page}`);
      } catch (err) {
        console.warn('static_page_pushState_failed', err);
      }
    }
  };

  const closeStaticPage = () => {
    setStaticPage(null);
    if (typeof window !== 'undefined') {
      try {
        window.history.pushState({}, '', '/');
      } catch (err) {
        console.warn('static_page_close_pushState_failed', err);
      }
    }
  };

  // Wire the OS/browser back button (popstate) to close the static page.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPop = () => setStaticPage(pathnameToStaticPage(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const [user, setUser]                     = useState<User | null>(null);
  // Distinguishes "signed out" from "we do not know yet". Without it the login
  // screen renders on every cold start until onAuthStateChanged fires, which on
  // a slow IndexedDB read is long enough for someone to tap Sign in with Google
  // and get a popup for a session they were already in.
  const [authResolved, setAuthResolved]     = useState(false);
  const [notes, setNotes]                   = useState<Note[]>([]);
  // Same distinction for the notes list: `notes` starts empty, so "No notes
  // yet — tap a recording option" rendered before the first snapshot arrived.
  // To a user with 40 meetings that reads as data loss.
  const [notesLoaded, setNotesLoaded]       = useState(false);
  const [notesError, setNotesError]         = useState<string | null>(null);
  const [activeTab, setActiveTab]           = useState('home');
  const [isRecording, setIsRecording]       = useState(false);
  const [showPreferences, setShowPreferences] = useState(false);
  const [showInstantConsent, setShowInstantConsent] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // A10 #4 support / feedback sheet. `supportKind` pre-selects the intent when
  // opened from the note view's "report an issue" control; `supportNoteId`
  // attaches the note as a reference (never its content).
  const [showSupport, setShowSupport] = useState(false);
  const [supportKind, setSupportKind] = useState<SupportKind>('contact');
  const [supportNoteId, setSupportNoteId] = useState<string | undefined>(undefined);
  const [recordingTime, setRecordingTime]   = useState(0);
  const [selectedNote, setSelectedNote]     = useState<Note | null>(null);
  const [isEditingNote, setIsEditingNote]   = useState(false);
  const [editDraft, setEditDraft]           = useState<EditableNoteFields | null>(null);
  const [savingNote, setSavingNote]         = useState(false);
  const [pendingNoteType, setPendingNoteType] = useState<NoteType | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [noteView, setNoteView]             = useState<'summary' | 'transcript'>('summary');
  const [recordingStream, setRecordingStream] = useState<MediaStream | null>(null);
  const [showImportSheet, setShowImportSheet] = useState(false);
  const [showScanSheet, setShowScanSheet] = useState(false);
  const [scanBusyLabel, setScanBusyLabel] = useState<string | null>(null);
  const [broadcastState, setBroadcastState] = useState<BroadcastState>('idle');
  const [broadcastDurationMs, setBroadcastDurationMs] = useState(0);
  const [showBroadcastInstructions, setShowBroadcastInstructions] = useState(false);
  const broadcastStartTimeoutRef = useRef<number | null>(null);
  const broadcastUploadInFlightRef = useRef<boolean>(false);
  const retryInFlightRef = useRef<Set<string>>(new Set());
  const stuckCheckRanForRef = useRef<Set<string>>(new Set());
  // Server-owned notes past their budget: reported, never failed from here.
  const [slowNoteIds, setSlowNoteIds] = useState<Set<string>>(new Set());
  // Notes for which we've already attempted an auto-retitle. Prevents
  // re-firing if the Firestore mirror of our own update echoes back
  // before the new title clears the PLACEHOLDER_TITLE_RE check.
  const retitleAttemptedRef = useRef<Set<string>>(new Set());
  // Synchronous guard against login double-taps. setSigningIn(true) is
  // async, so a fast double-tap during cold start could fire two
  // signInWith… popups before the disabled state propagates.
  const loginInFlightRef = useRef(false);
  const [signingIn, setSigningIn] = useState(false);

  // ── A9 billing + A6.3 guest state ──────────────────────────────
  const [entitlement, setEntitlement] = useState<EntitlementResponse | null>(null);
  const [showPaywall, setShowPaywall] = useState(false);
  const [paywallContext, setPaywallContext] = useState<PaywallContext>('manual');
  const [showAccountPrompt, setShowAccountPrompt] = useState(false);
  // Guard rails so once-per-session side effects don't re-fire on re-render or
  // on Firestore echo: anonymous bootstrap, and the first-summary funnel event.
  const anonAttemptedRef = useRef(false);
  const firstSummaryFiredRef = useRef(false);
  const openPaywall = (context: PaywallContext) => {
    setPaywallContext(context);
    setShowPaywall(true);
  };

  const isBroadcasting = broadcastState === 'starting' || broadcastState === 'recording';
  const broadcastSeconds = Math.floor(broadcastDurationMs / 1000);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recMimeRef = useRef<string>('audio/webm');
  // The elapsed time as a ref, because the auto-stop path reads it from inside
  // a closure captured when recording began — where it was still 0.
  const recordingTimeRef = useRef(0);
  // Always the current stopRecording, so the cap timer never calls a stale one.
  const stopRecordingRef = useRef<() => void>(() => {});
  const mountedRef = useRef<boolean>(true);
  const abortRef = useRef<AbortController | null>(null);
  const safeSetState = <T,>(setter: React.Dispatch<React.SetStateAction<T>>, val: T | ((p: T) => T)) => {
    if (mountedRef.current) setter(val as any);
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const platform = Capacitor.getPlatform();

  useEffect(() => {
    if (platform !== 'web') {
      BackgroundRecorder.isRecording().then(res => {
        if (res.recording) {
          const elapsed = res.startTimeMs ? Math.floor((Date.now() - res.startTimeMs) / 1000) : 0;
          safeSetState(setRecordingTime, elapsed);
          safeSetState(setIsRecording, true);
          safeSetState(setPendingNoteType, 'recording');
        }
      });
    }
  }, [platform]);

  // Listen for mid-recording errors from the native plugin (iOS encode
  // failure, disk full, OS interruption). Without this, a 60-minute
  // recording could fail silently and the user would only find out later.
  useEffect(() => {
    if (platform === 'web') return;
    let removed = false;
    const sub = BackgroundRecorder.addListener('recordingError', (data) => {
      if (removed) return;
      console.error('[recorder] native_recording_failed', { error: data.error, uid: user?.uid });
      // Reset all in-flight UI state. No note doc exists yet at this point
      // (uploadAndProcess hasn't run), so there's nothing to mark as error
      // server-side — just unwind the local state cleanly.
      safeSetState(setIsRecording, false);
      safeSetState(setRecordingStream, null);
      safeSetState(setPendingNoteType, null);
      safeSetState(setShowPreferences, false);
      const msg = data.error || 'Recording stopped unexpectedly';
      alert(`Recording stopped: ${msg}. Please try again.`);
    });
    return () => {
      removed = true;
      sub.then(h => h.remove());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]);

  // Poll broadcast status while a broadcast is pending or active.
  // Native is the source of truth — we just mirror its state here.
  useEffect(() => {
    if (platform === 'web') return;
    if (broadcastState === 'idle' || broadcastState === 'finished' || broadcastState === 'error') return;
    const poller = setInterval(async () => {
      try {
        const status = await BroadcastRecorder.getStatus();
        safeSetState(setBroadcastDurationMs, status.durationMs);

        if (status.state === 'recording' && broadcastState !== 'recording') {
          // Extension has confirmed broadcast — clear the start-timeout watchdog.
          if (broadcastStartTimeoutRef.current != null) {
            clearTimeout(broadcastStartTimeoutRef.current);
            broadcastStartTimeoutRef.current = null;
          }
          safeSetState(setBroadcastState, 'recording');
        } else if (status.state === 'finished' && status.hasCompletedRecording) {
          safeSetState(setBroadcastState, 'finished');
          handleBroadcastComplete();
        } else if (status.state === 'error') {
          safeSetState(setBroadcastState, 'error');
          alert(status.errorMessage ?? 'Broadcast failed. Please try again.');
          await BroadcastRecorder.clearRecording();
          safeSetState(setBroadcastState, 'idle');
          safeSetState(setBroadcastDurationMs, 0);
        }
      } catch (err) {
        console.warn('broadcast_poll_error', err);
      }
    }, 2000);
    return () => clearInterval(poller);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [broadcastState, platform]);

  // Recovery: on app mount, ask native for current broadcast state. If a
  // recording is sitting in the App Group container (e.g. AlgoMinutes was killed
  // mid-upload), pick it up. If a broadcast was active, resume the polling.
  useEffect(() => {
    if (platform === 'web' || !user) return;
    (async () => {
      try {
        const status = await BroadcastRecorder.getStatus();
        if (status.hasCompletedRecording && (status.state === 'finished' || status.state === 'error')) {
          safeSetState(setBroadcastState, 'finished');
          handleBroadcastComplete();
        } else if (status.state === 'recording' || status.state === 'starting') {
          safeSetState(setBroadcastState, status.state);
          safeSetState(setBroadcastDurationMs, status.durationMs);
        }
      } catch (err) {
        console.warn('broadcast_recovery_check_failed', err);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, user]);

  const startBroadcast = async () => {
    if (platform === 'web') {
      alert('Online meeting recording is available in the AlgoMinutes mobile app.');
      return;
    }
    // If isSupported throws (e.g., method missing on an older build), err on
    // the side of caution and surface the simulator message rather than silently
    // showing the consent sheet for a flow that can't complete.
    let supported: boolean | null = null;
    let reason: string | undefined;
    try {
      const support = await BroadcastRecorder.isSupported();
      supported = !!support.supported;
      reason = support.reason;
    } catch (err) {
      console.warn('broadcast_isSupported_failed', err);
    }
    if (supported === false) {
      alert(reason === 'simulator'
        ? 'Recording online meetings requires a real iPhone or iPad. Please run on a physical device.'
        : reason === 'android_version'
          ? 'Online meeting recording requires Android 10 or newer.'
          : 'Online meeting recording is not supported on this device.');
      return;
    }
    setShowBroadcastInstructions(true);
  };

  const continueAfterInstructions = async () => {
    setShowBroadcastInstructions(false);
    try {
      await BroadcastRecorder.startBroadcast();
      safeSetState(setBroadcastState, 'starting');
      safeSetState(setBroadcastDurationMs, 0);
      // Watchdog: if the user dismisses the picker or chooses a different app,
      // we'll never see state→recording. After 60s, give up and reset.
      if (broadcastStartTimeoutRef.current != null) {
        clearTimeout(broadcastStartTimeoutRef.current);
      }
      broadcastStartTimeoutRef.current = window.setTimeout(async () => {
        broadcastStartTimeoutRef.current = null;
        try {
          const status = await BroadcastRecorder.getStatus();
          if (status.state !== 'recording' && status.state !== 'finished') {
            await BroadcastRecorder.clearRecording();
            safeSetState(setBroadcastState, 'idle');
            safeSetState(setBroadcastDurationMs, 0);
            alert(platform === 'android'
              ? 'Meeting recording did not start. Approve Android screen/audio capture, then switch to your meeting app.'
              : 'Broadcast didn\'t start. In the iOS sheet, tap "Start Broadcast" and make sure AlgoMinutes is selected.');
          }
        } catch (err) {
          console.warn('broadcast_start_timeout_check_failed', err);
        }
      }, 60_000);
    } catch (err) {
      // Native rejected — most commonly the SIMULATOR_UNSUPPORTED early-reject.
      // Surface its actual message instead of the generic "couldn't open picker".
      console.error('Broadcast picker present failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      alert(msg && msg.length > 0 ? msg : 'Could not open the broadcast picker. Please try again.');
      safeSetState(setBroadcastState, 'idle');
    }
  };

  const handleBroadcastComplete = async () => {
    if (!user) return;
    if (broadcastUploadInFlightRef.current) return;
    broadcastUploadInFlightRef.current = true;
    const capturedDurationSec = Math.floor(broadcastDurationMs / 1000);
    try {
      const recording = await BroadcastRecorder.getRecording();
      if (platform === 'android') {
        console.info('[broadcast] android capture diagnostics', {
          appAudioCaptured: recording.appAudioCaptured,
          micAudioCaptured: recording.micAudioCaptured,
          appAudioPeak: recording.appAudioPeak,
          micAudioPeak: recording.micAudioPeak,
          appAudioRms: recording.appAudioRms,
          micAudioRms: recording.micAudioRms,
        });
        if (recording.appAudioCaptured === false && recording.micAudioCaptured) {
          alert('Android did not detect meeting-app audio. The recording will still upload your microphone audio, but it may miss other speakers if the meeting app blocks internal audio capture.');
        }
      }
      const response = await fetch(Capacitor.convertFileSrc(recording.filePath));
      const blob = await response.blob();
      if (blob.size === 0) {
        alert('No audio was captured from the broadcast.');
        await BroadcastRecorder.clearRecording();
        safeSetState(setBroadcastState, 'idle');
        safeSetState(setBroadcastDurationMs, 0);
        return;
      }
      await uploadAndProcess(blob, 'audio/mp4', 'm4a', 'online_meeting', capturedDurationSec);
      await BroadcastRecorder.clearRecording();
      safeSetState(setBroadcastState, 'idle');
      safeSetState(setBroadcastDurationMs, 0);
    } catch (err) {
      console.error('Broadcast recording retrieval failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      alert(msg.includes('too short') || msg.includes('audio was captured') || msg.includes('Android')
        ? msg
        : 'Could not retrieve the broadcast recording. Please try again.');
      try { await BroadcastRecorder.clearRecording(); } catch (clearErr) { console.warn('broadcast_clear_after_error_failed', clearErr); }
      safeSetState(setBroadcastState, 'idle');
      safeSetState(setBroadcastDurationMs, 0);
    } finally {
      broadcastUploadInFlightRef.current = false;
    }
  };

  // Pick the best MediaRecorder MIME for this browser that Gemini can consume.
  // Priority: ogg/opus (Firefox, Gemini-native) → webm/opus (Chrome/Edge, re-labelled as ogg in backend) → mp4 (Safari).
  const pickRecorderMime = (): string => {
    if (typeof MediaRecorder === 'undefined') return '';
    const candidates = [
      'audio/ogg;codecs=opus',
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
    ];
    for (const t of candidates) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  };

  const extForMime = (mime: string) => {
    if (mime.startsWith('audio/ogg')) return 'ogg';
    if (mime.startsWith('audio/mp4')) return 'm4a';
    return 'webm';
  };

  // A session the backend will not accept, even after a forced token refresh.
  // Leaving the user apparently signed in means every action fails with a
  // "please try again" that never succeeds; ending it cleanly at least gives
  // them something that works.
  useEffect(() => {
    setAuthExpiredHandler(() => {
      console.error('auth_session_expired — signing out');
      alert('Your session has expired. Please sign in again.');
      void signOut(auth).catch((err) => console.error('expired_signout_failed', err));
    });
    return () => setAuthExpiredHandler(null);
  }, []);

  // A9.5: any metered call that returns 402 quota_exceeded surfaces the paywall
  // with the server-returned entitlement. Wired here so the fetch layer stays
  // UI-agnostic (mirrors the auth-expired handler above).
  useEffect(() => {
    setQuotaExceededHandler((ent) => {
      if (ent) setEntitlement(ent);
      void track('quota_hit', { state: ent?.state ?? 'unknown' });
      openPaywall('quota');
    });
    return () => setQuotaExceededHandler(null);
  }, []);

  // A9.1: pull the server-resolved entitlement whenever the signed-in identity
  // changes (including the anonymous guest — it still has a Firebase token).
  // This is what the trial banner and free_floor gating read.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const controller = new AbortController();
    fetchEntitlement(controller.signal)
      .then((ent) => { if (!cancelled) setEntitlement(ent); })
      .catch((err) => {
        if ((err as { name?: string })?.name !== 'AbortError') {
          reportCrash('entitlement_fetch_failed', err);
        }
      });
    return () => { cancelled = true; controller.abort(); };
  }, [user]);

  // A9.6: purchase / cancellation funnel events on return from Stripe. Checkout
  // and the Billing Portal redirect back with a marker query param; emit the
  // event, refresh entitlement, then strip the param so a reload can't re-fire.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get('checkout');
    const billing = params.get('billing');
    if (!checkout && !billing) return;

    if (checkout === 'success') void track('purchase');
    if (billing === 'cancelled') void track('cancellation');

    // Re-resolve entitlement so UI reflects the new plan without a manual reload.
    if (auth.currentUser) {
      fetchEntitlement()
        .then(setEntitlement)
        .catch((err) => reportCrash('entitlement_refresh_failed', err));
    }

    params.delete('checkout');
    params.delete('billing');
    const qs = params.toString();
    try {
      window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
    } catch (err) {
      reportCrash('billing_return_url_cleanup_failed', err);
    }
  }, []);

  // Auth + workspace bootstrap
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setAuthResolved(true);

      // A6.3 guest mode: never a login wall at launch. If nobody is signed in,
      // open an anonymous session so the app is usable immediately; the account
      // prompt comes later, after the first summary. If anonymous auth is not
      // enabled for the project, signInAnonymously throws and we fall through to
      // the existing login screen — so behaviour is preserved either way.
      if (!u) {
        if (!anonAttemptedRef.current) {
          anonAttemptedRef.current = true;
          try {
            await ensureAnonymousIdentity();
          } catch (err) {
            reportCrash('anonymous_signin_failed', err);
          }
        }
        return;
      }

      // A permanent (non-anonymous) user means either a direct sign-in or a
      // successful guest upgrade — close the guest prompt if it was open.
      if (!u.isAnonymous) setShowAccountPrompt(false);

      // A10 #3 — capture timestamped Terms + Privacy acceptance at account
      // creation. Fires for a permanent account only (a guest has not "signed
      // up" yet), and once per uid + document version: a version bump requires
      // re-acceptance, an ordinary reload does not re-post. The server records
      // its own authoritative timestamp; a failure here is reported, not fatal.
      if (!u.isAnonymous) {
        const acceptKey = `terms_accepted:${u.uid}:${TERMS_VERSION}:${PRIVACY_VERSION}`;
        let alreadyAccepted = false;
        try { alreadyAccepted = localStorage.getItem(acceptKey) === '1'; } catch { /* silent-catch-ok: localStorage can be unavailable (private mode, blocked storage); no flag is the default */ }
        if (!alreadyAccepted) {
          void acceptTerms()
            .then(() => { try { localStorage.setItem(acceptKey, '1'); } catch { /* silent-catch-ok: localStorage can be unavailable (private mode, blocked storage); no flag is the default */ } })
            .catch((err) => reportCrash('accept_terms_on_signin_failed', err));
        }
      }

      if (u) {
        // Uncaught, this rejected into nothing — and it is the first Firestore
        // call of the session, so it is exactly where a rules or connectivity
        // problem shows up first.
        try {
          const ref = doc(db, 'workspaces', workspaceId(u.uid));
          const snap = await getDoc(ref);
          if (!snap.exists()) {
            await setDoc(ref, { name: 'My Workspace', ownerId: u.uid, members: [u.uid] });
          }
        } catch (err) {
          console.error('workspace_bootstrap_failed', err);
        }
      }
    });
    return () => unsub();
  }, []);

  // Real-time notes — with onError + exponential-backoff resubscribe so a
  // transient Firestore disconnect doesn't leave the UI stuck on stale data.
  useEffect(() => {
    if (!user) return;
    let unsub: (() => void) | null = null;
    let attempts = 0;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const subscribe = () => {
      if (cancelled) return;
      const q = query(
        collection(db, `workspaces/${workspaceId(user.uid)}/notes`),
        where('authorId', '==', user.uid),
      );
      unsub = onSnapshot(
        q,
        (snap) => {
          attempts = 0; // healthy connection — reset backoff
          const data = snap.docs.map(d => ({ id: d.id, ...d.data() } as Note));
          setNotes(data.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
          setNotesLoaded(true);
          setNotesError(null);
        },
        (err) => {
          console.error('[notes] listener_error', { err: err.message, attempt: attempts });
          attempts += 1;
          // Nothing was set in state here, so a listener failure was
          // indistinguishable from having no notes — permission-denied is not
          // transient, and it retried forever behind an empty list that looked
          // like every meeting had vanished.
          setNotesLoaded(true);
          setNotesError(
            err.code === 'permission-denied'
              ? "Your notes couldn't be loaded. Try signing out and back in."
              : "Your notes couldn't be loaded. Reconnecting…",
          );
          const delay = Math.min(60_000, 1000 * Math.pow(2, attempts));
          retryTimer = setTimeout(subscribe, delay);
        },
      );
    };
    subscribe();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (unsub) unsub();
    };
  }, [user]);

  // Stuck-note watchdog, every 60 s (lib/noteWatchdog).
  //
  // A note the client owns (`processing`: created before the upload, so no
  // server run exists yet) is failed here once its upload has gone quiet, or it
  // would sit on "Working on it" with no Try Again, which renders only in the
  // error branch. Uploads write `lastProgressAt`, so a live one isn't timed out.
  // Race-safety: the transaction re-reads the doc and writes only if it is
  // still `processing` (a kickoff may just have queued it).
  //
  // A note the server owns is only reported slow. Writing 'error' over it from
  // the browser left Postgres in flight: a retry got "already in flight", and
  // the note flipped back to 'error' 90 s later. The server's sweep fails a
  // stuck run itself (Postgres first), as on iOS (#124).
  useEffect(() => {
    if (!user) return;
    const tick = async () => {
      const wsId = workspaceId(user.uid);
      const { toFail, slow } = watchdogPass(notes, Date.now());
      setSlowNoteIds(new Set(slow));
      for (const noteId of toFail) {
        if (stuckCheckRanForRef.current.has(noteId)) continue;
        stuckCheckRanForRef.current.add(noteId);
        try {
          const noteRef = doc(db, `workspaces/${wsId}/notes`, noteId);
          await runTransaction(db, async (tx) => {
            const snap = await tx.get(noteRef);
            const data = snap.data() as Note | undefined;
            if (!data || data.status !== 'processing') return;
            tx.update(noteRef, {
              status: 'error',
              errorMessage: 'The upload stopped before it finished. Please try again.',
              diagnosticCode: 'CLIENT_TIMEOUT',
              updatedAt: new Date().toISOString(),
            });
          });
          console.warn('[watchdog] upload_stalled_marked_error', { noteId });
        } catch (err) {
          console.error('[watchdog] transaction_failed', { noteId, err });
        }
      }
    };
    const handle = setInterval(tick, 60_000);
    return () => clearInterval(handle);
  }, [user, notes]);

  // Keep the currently-open note in sync with Firestore so the detail view
  // flips from "processing" → "ready" (or "error") as soon as the backend updates.
  useEffect(() => {
    if (!selectedNote) return;
    const fresh = notes.find(n => n.id === selectedNote.id);
    if (fresh && fresh.updatedAt !== selectedNote.updatedAt) {
      setSelectedNote(fresh);
    }
  }, [notes, selectedNote]);

  // A9.6 + A6.3: the first time the user actually views a finished summary,
  // emit `first_summary_viewed`, then show the post-first-summary prompt — the
  // account prompt for a guest (A6.3), otherwise the paywall (A9.5). Never at
  // launch: this only fires on a ready summary. Once per browser (localStorage)
  // so it isn't nagged on every visit, plus a ref so a Firestore echo can't
  // double-fire it within the session.
  useEffect(() => {
    if (!user || !selectedNote) return;
    if (firstSummaryFiredRef.current) return;
    if (selectedNote.status !== 'ready' || noteView !== 'summary') return;
    if (!selectedNote.summary?.gist) return;

    let alreadySeen = false;
    try { alreadySeen = localStorage.getItem('first_summary_viewed') === '1'; } catch { /* silent-catch-ok: localStorage can be unavailable (private mode, blocked storage); no flag is the default */ }
    if (alreadySeen) { firstSummaryFiredRef.current = true; return; }

    firstSummaryFiredRef.current = true;
    try { localStorage.setItem('first_summary_viewed', '1'); } catch { /* silent-catch-ok: localStorage can be unavailable (private mode, blocked storage); no flag is the default */ }
    void track('first_summary_viewed', { noteType: selectedNote.type });

    // Defer the prompt so the summary is on screen first, not covered instantly.
    const t = setTimeout(() => {
      if (!mountedRef.current) return;
      if (auth.currentUser?.isAnonymous) {
        setShowAccountPrompt(true);
      } else if (entitlement?.state !== 'active') {
        openPaywall('first_summary');
      }
    }, 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, selectedNote, noteView]);

  // Leave edit mode whenever we navigate to a different note (or close the
  // detail view). Keyed on id only, so our own save — which keeps the same
  // id — doesn't yank the user out mid-edit; the explicit save handler exits.
  useEffect(() => {
    setIsEditingNote(false);
    setEditDraft(null);
  }, [selectedNote?.id]);

  // Seed the editable draft from the note and switch the detail view into
  // edit mode (summary tab only — transcript stays read-only).
  const beginEditNote = () => {
    if (!selectedNote) return;
    setEditDraft(draftFromNote(selectedNote));
    setNoteView('summary');
    setIsEditingNote(true);
  };

  const cancelEditNote = () => {
    setIsEditingNote(false);
    setEditDraft(null);
  };

  const handleSaveNote = async () => {
    if (!user || !selectedNote || !editDraft || savingNote) return;
    setSavingNote(true);
    try {
      await saveNoteEdits(user.uid, selectedNote.id, selectedNote.summary, editDraft);
      setIsEditingNote(false);
      setEditDraft(null);
    } catch (err) {
      console.error('note_edit_save_failed', { noteId: selectedNote.id, err });
      alert(err instanceof Error ? err.message : 'Could not save your changes. Please try again.');
    } finally {
      setSavingNote(false);
    }
  };

  // Helpers for editing the two list fields in the draft.
  const updateDraftList = (
    key: 'actionItems' | 'keyDecisions',
    updater: (list: string[]) => string[],
  ) => setEditDraft((d) => (d ? { ...d, [key]: updater(d[key]) } : d));

  // Auto-retitle ready notes whose title is still the placeholder
  // "Session_<date>" / "Import_<date>". Picks the first sentence of the
  // executive gist and persists it through the /api/update-note endpoint
  // (renameNote) so Postgres — not just Firestore — gets the real title;
  // otherwise search would keep indexing the placeholder. Idempotent +
  // bounded by retitleAttemptedRef so a Firestore mirror echo can't trigger
  // an infinite update loop.
  useEffect(() => {
    if (!user) return;
    notes.forEach(async (note) => {
      if (note.status !== 'ready') return;
      if (!PLACEHOLDER_TITLE_RE.test(note.title || '')) return;
      if (retitleAttemptedRef.current.has(note.id)) return;
      const next = deriveTitleFromSummary(note.summary);
      if (!next) return;
      retitleAttemptedRef.current.add(note.id);
      try {
        await renameNote(user.uid, note.id, next);
      } catch (err) {
        console.warn('auto_retitle_failed', { noteId: note.id, err });
        // Allow a future retry if the user reopens the note.
        retitleAttemptedRef.current.delete(note.id);
      }
    });
  }, [notes, user]);

  // Recording timer with the 2-hour hard cap.
  //
  // This used to schedule the auto-stop from inside a setState updater — a side
  // effect in a place React may call more than once — and the stopRecording it
  // called was the one captured on the render where isRecording first became
  // true. On that render recordingTime was 0, so a recording that hit the cap
  // was filed with a duration of 0. Elapsed time and the stop function are now
  // both read through refs, which are current by construction.
  useEffect(() => {
    if (!isRecording) {
      setRecordingTime(0);
      recordingTimeRef.current = 0;
      return;
    }
    const t = setInterval(() => {
      const next = recordingTimeRef.current + 1;
      recordingTimeRef.current = next;
      setRecordingTime(next);
      if (next >= MAX_RECORDING_SECONDS) stopRecordingRef.current();
    }, 1000);
    return () => clearInterval(t);
  }, [isRecording]);

  // Warn before a refresh or tab close discards an in-progress recording.
  // Chunks live only in chunksRef and are never flushed anywhere, so closing
  // the tab silently destroys the whole meeting.
  useEffect(() => {
    if (!isRecording) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isRecording]);


  const handleLogin = async (provider: 'apple' | 'google' = 'google') => {
    if (loginInFlightRef.current) return;
    loginInFlightRef.current = true;
    setSigningIn(true);
    try {
    console.log('[auth] handleLogin start', { platform, provider });
    if (platform === 'web') {
      const webProvider = provider === 'apple' ? new OAuthProvider('apple.com') : new GoogleAuthProvider();
      await signInWithPopup(auth, webProvider);
      return;
    }

    if (provider === 'apple') {
      console.log('[auth] calling FirebaseAuthentication.signInWithApple');
      const result = await FirebaseAuthentication.signInWithApple();
      console.log('[auth] got Apple result', { hasIdToken: !!result.credential?.idToken });
      const idToken = result.credential?.idToken;
      const nonce = result.credential?.nonce;
      if (!idToken) throw new Error('Apple Sign-In failed: no ID token returned');
      const oauth = new OAuthProvider('apple.com');
      const credential = oauth.credential({ idToken, rawNonce: nonce });
      console.log('[auth] calling signInWithCredential (apple)');
      const userCred = await signInWithCredential(auth, credential);
      console.log('[auth] signInWithCredential resolved', { uid: userCred.user.uid });
      return;
    }

    console.log('[auth] calling FirebaseAuthentication.signInWithGoogle');
    const result = await FirebaseAuthentication.signInWithGoogle();
    console.log('[auth] got Google result', { hasIdToken: !!result.credential?.idToken });
    const idToken = result.credential?.idToken;
    if (!idToken) throw new Error('Google Sign-In failed: no ID token returned');
    const credential = GoogleAuthProvider.credential(idToken);
    console.log('[auth] calling signInWithCredential (google)');
    const userCred = await signInWithCredential(auth, credential);
    console.log('[auth] signInWithCredential resolved', { uid: userCred.user.uid });
    } finally {
      loginInFlightRef.current = false;
      setSigningIn(false);
    }
  };

  const startAction = (type: NoteType) => {
    // A9.3 free floor: once the reverse trial has lapsed to the thin free tier
    // (or the current period is over quota), gate the metered capture/import
    // actions behind the paywall. Server-side enforcement (402) is the real
    // guard; this just avoids a wasted round-trip and shows intent up front.
    const meteredTypes: NoteType[] = ['recording', 'import_audio', 'online_meeting', 'youtube'];
    if (meteredTypes.includes(type) && (entitlement?.state === 'free_floor' || entitlement?.overQuota)) {
      openPaywall('free_floor');
      return;
    }
    setPendingNoteType(type);
    if (type === 'import_audio' || type === 'youtube') {
      setShowImportSheet(true);
    } else if (type === 'online_meeting') {
      startBroadcast();
    } else if (type === 'scan_text') {
      setShowScanSheet(true);
    } else {
      setShowPreferences(true);
    }
  };

  const finalizeExtractedTextNote = async (
    noteRef: any,
    rawText: string,
    sourceLabel: string,
    placeholderTitle: string,
    sourceBlob?: Blob,
    storagePath?: string,
    mimeType?: string
  ) => {
    const maxTextChars = 180_000;
    const normalized = rawText.replace(/\u0000/g, '').trim();
    const wasTruncated = normalized.length > maxTextChars;
    const trimmed = wasTruncated
      ? `${normalized.slice(0, maxTextChars).trimEnd()}\n\n[Text truncated for mobile display.]`
      : normalized;
    const transcriptLines = trimmed.length > 0
      ? trimmed.split(/\n+/).filter((l) => l.trim().length > 0).map((text) => ({ speaker: sourceLabel, time: '', text }))
      : [{ speaker: sourceLabel, time: '', text: `No text detected in ${sourceLabel.toLowerCase()}.` }];

    const wordCount = trimmed.length > 0 ? trimmed.split(/\s+/).filter(Boolean).length : 0;
    const gistFirstPara = trimmed.split(/\n\s*\n/)[0].slice(0, 500).trim();
    const summary: Summary = {
      gist: trimmed.length > 0
        ? `${sourceLabel} - ${wordCount} words extracted${wasTruncated ? ' (truncated)' : ''}.\n\n${gistFirstPara}${gistFirstPara.length < trimmed.length ? '...' : ''}`
        : `${sourceLabel} - no text detected.`,
      actionItems: [],
      keyDecisions: [],
    };

    const firstLine = transcriptLines.find((l) => l.text.length >= 5)?.text;
    const title = firstLine && trimmed.length > 0
      ? firstLine.slice(0, 60) + (firstLine.length > 60 ? '...' : '')
      : placeholderTitle;

    await setDoc(noteRef, {
      status: 'ready',
      title,
      updatedAt: new Date().toISOString(),
      transcript: transcriptLines,
      transcriptTruncated: wasTruncated,
      summary,
      rawText: trimmed,
      wordCount,
    }, { merge: true });

    if (sourceBlob && storagePath) {
      try {
        const sRef = ref(storage, storagePath);
        await uploadBytes(sRef, sourceBlob, { contentType: mimeType || sourceBlob.type || 'application/octet-stream' });
      } catch (err) {
        console.warn('scan_text_source_upload_failed', err);
      }
    }
  };

  // processScanText logic removed: handled perfectly by processDocumentTextFile via HTML5 file input

  const processDocumentTextFile = async (file: File) => {
    if (!user || scanBusyLabel) return;
    safeSetState(setShowScanSheet, false);
    safeSetState(setPendingNoteType, null);

    const wsId = workspaceId(user.uid);
    const noteRef = doc(collection(db, `workspaces/${wsId}/notes`));
    const noteId = noteRef.id;
    const now = new Date();
    const sourceExt = filenameExt(file.name) || mimeExt(file.type) || 'bin';
    const mimeType = file.type || 'application/octet-stream';
    const storagePath = `scans/${wsId}/${noteId}.${sourceExt}`;
    const placeholderTitle = file.name.replace(/\.[^.]+$/, '') || `Import ${now.toISOString().slice(0, 10)}`;
    const sourceLabel = documentSourceLabel(file);

    const initialNote: Partial<Note> = {
      id: noteId,
      title: placeholderTitle,
      authorId: user.uid,
      workspaceId: wsId,
      status: 'processing',
      type: 'scan_text',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      duration: 0,
      mimeType,
      storagePath,
    };
    try {
      await setDoc(noteRef, initialNote);
    } catch (err) {
      console.error('scan_note_create_failed', err);
      alert('Could not save this document to your account. Check your connection and try again.');
      return;
    }
    safeSetState(setSelectedNote, initialNote as Note);

    try {
      const text = await extractTextFromFile(file, () => {
        setDoc(noteRef, { lastProgressAt: new Date().toISOString() }, { merge: true })
          .catch((progressErr) => console.error('scan_text_progress_mirror_failed', progressErr));
      });
      await finalizeExtractedTextNote(noteRef, text, sourceLabel, placeholderTitle, file, storagePath, mimeType);
    } catch (err) {
      console.error('document_text_extract_failed', err);
      const msg = err instanceof Error ? err.message : 'Could not read this document.';
      await setDoc(noteRef, { status: 'error', errorMessage: msg, updatedAt: new Date().toISOString() }, { merge: true });
    }
  };

  // createPdfFromCamera logic removed: handled perfectly by createPdfFromImages via HTML5 file input

  const createPdfFromImages = async (files: File[]) => {
    if (scanBusyLabel) return;
    const images = files.filter((file) => file.type.startsWith('image/')).slice(0, 30);
    if (images.length === 0) return;
    safeSetState(setScanBusyLabel, 'Building PDF...');
    try {
      const pdfBlob = await imagesToPdfBlob(images);
      const fileName = `${(images[0].name || 'Scan').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_').slice(0, 60)}.pdf`;
      await saveOrShareBlob(pdfBlob, fileName, 'Save or share PDF', 'AlgoMinutes scanned PDF');
      safeSetState(setShowScanSheet, false);
    } catch (err) {
      console.error('images_pdf_failed', err);
      alert('Could not create PDF: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      safeSetState(setScanBusyLabel, null);
    }
  };

  const saveOrShareBlob = async (blob: Blob, fileName: string, title: string, text: string) => {
    if (platform !== 'web') {
      const base64 = await blobToBase64(blob);
      const path = `exports/${fileName}`;
      await Filesystem.writeFile({
        path,
        data: base64,
        directory: Directory.Cache,
        recursive: true,
      });
      const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
      await Share.share({
        title: fileName,
        text,
        files: [uri],
        dialogTitle: title,
      });
      return;
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const blobToBase64 = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not prepare file for sharing.'));
    reader.onload = () => {
      const dataUri = String(reader.result || '');
      resolve(dataUri.slice(dataUri.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });

  const documentSourceLabel = (file: File): string => {
    const ext = filenameExt(file.name);
    if (file.type.startsWith('image/')) return 'Scanned image';
    if (file.type === 'application/pdf' || ext === 'pdf') return 'PDF document';
    if (ext === 'docx') return 'Word document';
    return 'Imported document';
  };

  const filenameExt = (name: string): string => {
    const m = /\.([a-zA-Z0-9]+)$/.exec(name);
    return m ? m[1].toLowerCase() : '';
  };

  const mimeExt = (mime: string): string => {
    if (!mime) return '';
    if (mime.includes('pdf')) return 'pdf';
    if (mime.includes('wordprocessingml')) return 'docx';
    if (mime.startsWith('image/jpeg')) return 'jpg';
    if (mime.startsWith('image/png')) return 'png';
    if (mime.startsWith('image/')) return 'jpg';
    if (mime.startsWith('text/')) return 'txt';
    return '';
  };

  const beginSession = async () => {
    if (platform !== 'web') {
      try {
        await BackgroundRecorder.start();
        recMimeRef.current = 'audio/mp4';
        setShowPreferences(false);
        setIsRecording(true);
      } catch (err) {
        console.error('Native recorder start failed:', err);
        alert('Microphone access is required to record. Please check your device settings.');
      }
      return;
    }

    if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      alert("Recording isn't supported on this browser. Please try a recent Chrome, Edge, or Firefox.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.error('Mic access denied:', err);
      alert('Microphone access is required to record. Please check your browser settings and try again.');
      return;
    }
    try {
      const mime = pickRecorderMime();
      recMimeRef.current = mime || 'audio/webm';
      const mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      // Capture can die without the recorder ever being stopped: the mic
      // permission is revoked mid-session, a Bluetooth headset disconnects, or
      // the device the track came from goes away. None of this was handled, so
      // the track ended, no data arrived, the timer kept counting, and the
      // screen kept saying "Recording in progress" — until the doctor pressed
      // stop and got "No audio captured" with the meeting gone.
      //
      // Stopping here keeps everything captured up to this point, because the
      // chunks already collected are what stopRecording assembles.
      const captureLost = (reason: string) => {
        const rec = mediaRecorderRef.current;
        if (!rec || rec.state === 'inactive') return;
        console.error('recording_capture_lost', { reason });
        const kept = chunksRef.current.length > 0;
        alert(
          kept
            ? 'Recording stopped because the microphone became unavailable. '
              + "We've kept everything recorded up to that point."
            : 'Recording stopped because the microphone became unavailable, '
              + 'before any audio was captured.'
        );
        stopRecordingRef.current();
      };

      mediaRecorder.onerror = (e) => captureLost(String((e as ErrorEvent)?.error ?? 'recorder error'));
      const track = stream.getAudioTracks()[0];
      if (track) track.onended = () => captureLost('input track ended');

      mediaRecorder.start(1000);
      setShowPreferences(false);
      setRecordingStream(stream);
      setIsRecording(true);
    } catch (err) {
      console.error('MediaRecorder init failed:', err);
      stream.getTracks().forEach(t => t.stop());
      alert("Recording isn't supported on this browser. Please try a recent Chrome, Edge, or Firefox.");
    }
  };

  const uploadAndProcess = async (blob: Blob, mime: string, ext: string, capturedType: NoteType, capturedDuration: number) => {
    if (!user) return;
    const wsId = workspaceId(user.uid);
    const noteRef = doc(collection(db, `workspaces/${wsId}/notes`));
    const noteId = noteRef.id;

    const storagePath = `recordings/${wsId}/${noteId}.${ext}`;
    const note: Partial<Note> = {
      id: noteId,
      title: `${capturedType === 'recording' ? 'Session' : 'Import'}_${new Date().toISOString().slice(0, 10)}`,
      authorId: user.uid,
      workspaceId: wsId,
      status: 'processing',
      type: capturedType,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      duration: capturedDuration,
      storagePath,
      mimeType: mime,
    };

    // A failed write here used to produce absolutely nothing: no note, no
    // error, no alert. The doctor stopped recording and the app simply did
    // not respond. The audio is still in `blob`, so say so rather than
    // implying it is gone.
    try {
      await setDoc(noteRef, note);
    } catch (err) {
      console.error('note_create_failed', err);
      alert(
        'Could not save this recording to your account. Check your connection '
        + 'and try again — the audio has not been discarded.',
      );
      safeSetState(setPendingNoteType, null);
      return;
    }
    safeSetState(setSelectedNote, note as Note);

    const sRef = ref(storage, storagePath);
    const markKickoffError = async (message: string) => {
      try {
        await markNoteError(noteRef, message);
      } catch (mirrorErr) {
        console.error('kickoff_error_mirror_failed', mirrorErr);
      }
    };

    const uploadTask = uploadBytesResumable(sRef, blob, { contentType: mime });

    // 5-minute upload timeout: on flaky networks Firebase Storage can stall
    // forever without firing the error callback. Cancel-on-timeout converts
    // that into a normal error path.
    let uploadTimedOut = false;
    const uploadTimeout = setTimeout(() => {
      uploadTimedOut = true;
      try { uploadTask.cancel(); } catch (cancelErr) { console.warn('upload_cancel_failed', cancelErr); }
    }, 5 * 60_000);

    // Heartbeat the note while bytes are moving. The doc is written with
    // status 'processing' BEFORE the upload starts, and that status has a
    // 90-second watchdog budget — so without a progress signal any upload
    // longer than 90s (a 2-hour recording is ~57 MB) would be flipped to
    // error by its own client, mid-upload. This is what `lastProgressAt`
    // exists for; the upload path simply never wrote it.
    let lastHeartbeatAt = 0;
    const HEARTBEAT_MS = 30_000;

    uploadTask.on(
      'state_changed',
      (snapshot) => {
        safeSetState(
          setUploadProgress,
          snapshot.totalBytes > 0
            ? Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100)
            : 0,
        );
        const now = Date.now();
        if (now - lastHeartbeatAt >= HEARTBEAT_MS) {
          lastHeartbeatAt = now;
          setDoc(noteRef, { lastProgressAt: new Date().toISOString() }, { merge: true })
            .catch((err) => console.error('upload_heartbeat_failed', err));
        }
      },
      async (error) => {
        clearTimeout(uploadTimeout);
        console.error('Upload failed', error);
        safeSetState(setUploadProgress, 0);
        const errCode = (error as any)?.code;
        let msg: string;
        if (uploadTimedOut || errCode === 'storage/canceled') {
          msg = 'Upload stopped because the connection dropped. Please try again.';
        } else if (errCode === 'storage/unauthorized' && blob.size >= 120 * 1024 * 1024) {
          // storage/unauthorized is the generic rules rejection — an expired
          // token or a wrong content type produce it too. Only blame size when
          // the file actually is oversized.
          msg = 'That recording is too large. The current limit is 120 MB.';
        } else {
          msg = 'Upload failed. Please check your connection and try again.';
        }
        try {
          await setDoc(noteRef, { status: 'error', errorMessage: msg, updatedAt: new Date().toISOString() }, { merge: true });
        } catch (mirrorErr) {
          console.error('upload_error_mirror_failed', mirrorErr);
        }
        safeSetState(setPendingNoteType, null);
      },
      async () => {
        clearTimeout(uploadTimeout);
        safeSetState(setUploadProgress, 0);
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        try {
          const resp = await authedFetch(
            '/api/process-audio',
            { noteId, workspaceId: wsId, type: capturedType, storagePath, mimeType: mime },
            controller.signal,
          );
          if (!resp.ok) {
            console.error('process-audio failed', resp.status, await readErrorText(resp));
            await markKickoffError('Could not queue your recording. Please try again.');
          }
        } catch (e) {
          if ((e as any)?.name !== 'AbortError') {
            console.error('process-audio fetch error', e);
            await markKickoffError('Could not queue your recording. Please try again.');
          }
        }
        // Delete the local file on native after successful upload
        if (platform !== 'web') {
          try { await BackgroundRecorder.deleteFile(); } catch (err) { console.warn('native_file_cleanup_failed', err); }
        }
        safeSetState(setPendingNoteType, null);
      },
    );
  };

  const stopRecording = async () => {
    if (!user || !pendingNoteType) {
      safeSetState(setIsRecording, false);
      return;
    }

    const capturedType = pendingNoteType;
    // From the ref, not the state. The auto-stop path calls this through a
    // closure created when recording began, where recordingTime was 0 — so a
    // recording that ran to the cap was filed as zero seconds long.
    const capturedDuration = recordingTimeRef.current;

    if (platform !== 'web') {
      try {
        await BackgroundRecorder.stop();
        safeSetState(setIsRecording, false);
        const fileInfo = await BackgroundRecorder.getFile();
        const response = await fetch(Capacitor.convertFileSrc(fileInfo.filePath));
        const blob = await response.blob();

        if (blob.size === 0) {
          alert('No audio captured. Please try again.');
          safeSetState(setPendingNoteType, null);
          return;
        }

        await uploadAndProcess(blob, 'audio/mp4', 'm4a', capturedType, capturedDuration);
      } catch (err) {
        safeSetState(setIsRecording, false);
        console.error('Native recording stop/upload failed:', err);
        alert('Recording failed. Please try again.');
        safeSetState(setPendingNoteType, null);
      }
      return;
    }

    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    safeSetState(setIsRecording, false);

    const mime = recMimeRef.current;
    const ext = extForMime(mime);

    recorder.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: mime });
      chunksRef.current = [];
      try {
        recorder.stream.getTracks().forEach(t => t.stop());
      } catch (err) {
        console.warn('mediaTrack_stop_failed', err);
      }
      mediaRecorderRef.current = null;
      safeSetState(setRecordingStream, null);

      if (blob.size === 0) {
        alert('No audio captured. Please try again.');
        safeSetState(setPendingNoteType, null);
        return;
      }

      await uploadAndProcess(blob, mime, ext, capturedType, capturedDuration);
    };

    try {
      recorder.stop();
    } catch (e) {
      console.error('Recorder stop failed', e);
    }
  };

  // Keep the cap timer and the capture-lost handlers pointed at the current
  // stopRecording rather than whichever one existed when recording started.
  useEffect(() => {
    stopRecordingRef.current = () => { void stopRecording(); };
  });

  const MAX_RETRY_ATTEMPTS = 3;

  const retryProcessing = async (note: Note) => {
    if (!user) return;

    // Idempotency: prevent double-fire from rapid taps. Same noteId = no-op
    // until the in-flight call resolves.
    if (retryInFlightRef.current.has(note.id)) {
      console.warn('[retry] already_in_flight', { noteId: note.id });
      return;
    }
    retryInFlightRef.current.add(note.id);

    try {
      const wsId = workspaceId(user.uid);
      const noteRef = doc(db, `workspaces/${wsId}/notes`, note.id);
      const markRetryError = async (message: string) => {
        try {
          await markNoteError(noteRef, message);
        } catch (mirrorErr) {
          console.error('retry_error_mirror_failed', mirrorErr);
        }
      };

      // Max-retry policy: cap to MAX_RETRY_ATTEMPTS to stop runaway retries
      // (cost / abuse / known-deterministic-failure cases).
      const currentAttempts = note.retryAttempt ?? 0;
      if (currentAttempts >= MAX_RETRY_ATTEMPTS) {
        alert(
          `We've already tried this ${currentAttempts} times. Please try uploading the file directly, ` +
          'or contact support if the problem persists.',
        );
        return;
      }
      const nextAttempt = currentAttempts + 1;

      const isYouTube = note.type === 'youtube';
      const sourceUrl = typeof note.sourceUrl === 'string' ? note.sourceUrl.trim() : '';
      if (isYouTube && !sourceUrl) {
        await markRetryError('Original YouTube link is missing. Please import the URL again.');
        return;
      }
      const storagePath = note.storagePath || `recordings/${wsId}/${note.id}.webm`;
      const mimeType = note.mimeType || 'audio/webm';
      const retryBody = isYouTube
        ? { noteId: note.id, workspaceId: wsId, type: 'youtube', sourceUrl, retryAttempt: nextAttempt }
        : { noteId: note.id, workspaceId: wsId, type: note.type, storagePath, mimeType, retryAttempt: nextAttempt };
      try {
        // Atomic update: clear error state + bump retry counter together.
        await setDoc(noteRef, {
          status: 'queued',
          errorMessage: null,
          retryAttempt: nextAttempt,
          updatedAt: new Date().toISOString(),
        }, { merge: true });
        const controller = new AbortController();
        abortRef.current = controller;
        const resp = await authedFetch(
          '/api/process-audio',
          retryBody,
          controller.signal,
        );
        if (!resp.ok) {
          const responseText = await readErrorText(resp);
          console.error(`[retry] kickoff_failed noteId=${note.id} status=${resp.status} attempt=${nextAttempt} body=${responseText}`);
          await markRetryError('Could not queue this retry. Please try again.');
        } else {
          console.log(`[retry] kickoff_ok noteId=${note.id} attempt=${nextAttempt}`);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`[retry] exception noteId=${note.id} attempt=${nextAttempt} message=${message}`);
        await markRetryError('Could not queue this retry. Please try again.');
      }
    } finally {
      retryInFlightRef.current.delete(note.id);
    }
  };

  const fmt = (s: number) =>
    `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;

  const generatePDF = async (note: Note) => {
    const { jsPDF } = await import('jspdf');
    const pdf = new jsPDF();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const bottomMargin = 20;
    let y = 22;
    const ensureRoom = (next: number) => {
      if (y + next > pageHeight - bottomMargin) {
        pdf.addPage();
        y = 20;
      }
    };
    const writeLines = (textLines: string[], lineHeight = 6) => {
      for (const line of textLines) {
        ensureRoom(lineHeight);
        pdf.text(line, 20, y);
        y += lineHeight;
      }
    };

    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(20);
    writeLines(pdf.splitTextToSize(note.title || 'Untitled', 170), 10);

    y += 6;
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(14);
    ensureRoom(10); pdf.text('Executive Summary', 20, y); y += 8;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(11);
    writeLines(pdf.splitTextToSize(note.summary?.gist || 'No summary.', 170));

    if (note.rawText) {
      y += 6;
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(14);
      ensureRoom(10); pdf.text('Extracted Text', 20, y); y += 8;
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(10);
      writeLines(pdf.splitTextToSize(note.rawText, 170), 5.5);
    }

    y += 6;
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(14);
    ensureRoom(10); pdf.text('Action Items', 20, y); y += 8;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(11);
    (note.summary?.actionItems || []).forEach(item => {
      const lines = pdf.splitTextToSize(`- ${item}`, 168);
      for (const line of lines) { ensureRoom(7); pdf.text(line, 22, y); y += 7; }
    });

    y += 6;
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(14);
    ensureRoom(10); pdf.text('Key Decisions', 20, y); y += 8;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(11);
    (note.summary?.keyDecisions || []).forEach(item => {
      const lines = pdf.splitTextToSize(`- ${item}`, 168);
      for (const line of lines) { ensureRoom(7); pdf.text(line, 22, y); y += 7; }
    });

    const safeName = (note.title || 'Summary').replace(/[^\w\-]+/g, '_').slice(0, 80);
    const fileName = `${safeName}_Summary.pdf`;

    if (platform !== 'web') {
      const dataUri = pdf.output('datauristring');
      const base64 = dataUri.slice(dataUri.indexOf(',') + 1);
      const path = `exports/${fileName}`;
      await Filesystem.writeFile({
        path,
        data: base64,
        directory: Directory.Cache,
        recursive: true,
      });
      const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
      await Share.share({
        title: fileName,
        text: `AlgoMinutes summary: ${note.title || 'Untitled'}`,
        files: [uri],
        dialogTitle: 'Save or share PDF',
      });
      return;
    }

    const blob = pdf.output('blob');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // ── Shared accent style helpers ──────────────────────────────
  const accentGrad = 'linear-gradient(135deg, #F2F7FF 0%, #DCEAFF 100%)';
  const accentShadow = '0 6px 24px rgba(91, 103, 240,0.45)';

  // A9.5 paywall + A6.3 account prompt. Shared across the home and note-detail
  // views because both triggers (first-summary, quota-hit) can fire while a note
  // is open — and the note-detail view returns early, before the home tree.
  const billingModals = (
    <>
      <Paywall
        open={showPaywall}
        context={paywallContext}
        entitlement={entitlement}
        onClose={() => setShowPaywall(false)}
        onShowTerms={() => { setShowPaywall(false); showStaticPage('terms'); }}
        onShowPrivacy={() => { setShowPaywall(false); showStaticPage('privacy'); }}
      />
      <AccountPrompt
        open={showAccountPrompt}
        platform={platform}
        onDismiss={() => setShowAccountPrompt(false)}
        onUpgradeGoogle={async () => { await upgradeGuestWithGoogle(); }}
        onUpgradeApple={async () => { await upgradeGuestWithApple(); }}
        onShowTerms={() => { setShowAccountPrompt(false); showStaticPage('terms'); }}
        onShowPrivacy={() => { setShowAccountPrompt(false); showStaticPage('privacy'); }}
      />
    </>
  );

  // ─────────────────────────────────────────────────────────────
  // STATIC LEGAL PAGES — before the auth gate, deliberately
  // ─────────────────────────────────────────────────────────────
  // These must render signed-out. ios-native/DEVIATIONS.md §5 has the iOS app
  // linking to the hosted /privacy and /terms as the single source of truth,
  // "still reviewer-reachable" — and an App Store reviewer is not signed in.
  // Rendering this after `if (!user)` sent them to a login wall instead, and
  // took the login screen's own Privacy/Terms buttons down with it: they set
  // state that the later render was never reached to read.
  //
  // Hook-safe: every hook above runs unconditionally, so returning here does
  // not change hook order. A future /s/:token share route needs this same
  // placement.
  // Share links render before the auth gate for the same reason the legal
  // pages do: the reader is not signed in and never will be. Placed first —
  // a token URL is unambiguous, so nothing else needs to be consulted.
  if (typeof window !== 'undefined') {
    const shareToken = shareTokenFromPath(window.location.pathname);
    if (shareToken) return <SharedNote token={shareToken} />;
  }

  if (staticPage === 'privacy') {
    return <PrivacyPolicy onBack={closeStaticPage} />;
  }
  if (staticPage === 'terms') {
    return <TermsOfService onBack={closeStaticPage} />;
  }
  // A10 #3 — public account-deletion request page (Google Play requirement).
  // Placed with the legal pages, before the auth gate, so it is reachable at a
  // stable /delete-account URL without signing in or navigating into the app.
  // A guest counts as "signed out" here: only a permanent account deletes in
  // place; everyone else sees the request-by-email/in-app instructions.
  if (staticPage === 'delete-account') {
    return (
      <DeleteAccount
        authResolved={authResolved}
        isSignedIn={!!user && !user.isAnonymous}
        email={user?.email}
        onBack={closeStaticPage}
        onDeleted={async () => { await signOut(auth).catch((err) => reportCrash('delete_account_signout_failed', err)); }}
      />
    );
  }

  // ─────────────────────────────────────────────────────────────
  // LOGIN
  // ─────────────────────────────────────────────────────────────

  // Hold the frame until auth has actually resolved. `user` starts null, so
  // without this the full login screen rendered on every cold start until
  // onAuthStateChanged fired — long enough on a slow IndexedDB read for someone
  // to tap Sign in and get a popup for the session they were already in.
  if (!authResolved) {
    return (
      <div className="owll-login-bg min-h-screen flex items-center justify-center p-8">
        <div className="owll-bg" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="owll-login-bg min-h-screen flex flex-col items-center justify-center p-8 relative overflow-hidden">
        <div className="owll-bg" />
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, ease: 'easeOut' }}
          className="max-w-sm w-full text-center relative z-10"
        >
          {/* Logo */}
          <motion.div
            initial={{ scale: 0.85, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.1, duration: 0.45 }}
            className="flex justify-center mb-10"
          >
            <img
              src="/logo.png"
              alt="AlgoMinutes"
              className="h-20 w-auto"
              style={{ filter: 'drop-shadow(0 0 28px rgba(91, 103, 240,0.55))' }}
            />
          </motion.div>

          <h1
            style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '2.6rem', fontWeight: 800, color: '#FFFFFF', marginBottom: '0.5rem' }}
          >
            AlgoMinutes
          </h1>
          <p style={{ color: '#8C8684', fontFamily: 'Titillium Web, sans-serif', fontSize: '1rem', marginBottom: '3rem' }}>
            Your intelligent AI meeting &amp; document assistant.
          </p>

          {/* Apple sign-in is offered on iOS AND on the web. handleLogin's web
              branch already routes 'apple' through OAuthProvider('apple.com')
              with signInWithPopup — the button simply was not rendered, so a
              browser user only ever saw Google. Apple sign-in is also what
              lets someone use Hide My Email, which matters for a clinician
              who would rather not hand over a work address. */}
          {platform === 'ios' || platform === 'web' ? (
            <div className="w-full flex flex-col gap-3">
              <button
                onClick={async () => { try { await handleLogin('apple'); } catch (err) { console.error('Apple sign-in failed', err); const m = signInErrorMessage(err, 'apple'); if (m) alert(m); } }}
                disabled={signingIn}
                className="owll-btn-primary w-full py-4 text-base flex items-center justify-center gap-3 disabled:opacity-60 disabled:cursor-not-allowed"
                style={{ background: '#FFFFFF', color: '#000000', boxShadow: '0 4px 16px rgba(0,0,0,0.3)' }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/>
                </svg>
                Sign in with Apple
              </button>
              <button
                onClick={async () => { try { await handleLogin('google'); } catch (err) { console.error('Google sign-in failed', err); const m = signInErrorMessage(err, 'google'); if (m) alert(m); } }}
                disabled={signingIn}
                className="owll-btn-primary w-full py-4 text-base flex items-center justify-center gap-3 disabled:opacity-60 disabled:cursor-not-allowed"
                style={{ background: '#1A1A1A', color: '#FFFFFF', border: '1px solid #2A2A2A' }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                Sign in with Google
              </button>
            </div>
          ) : (
            <button
              onClick={async () => { try { await handleLogin('google'); } catch (err) { console.error('Google sign-in failed', err); const m = signInErrorMessage(err, 'google'); if (m) alert(m); } }}
              disabled={signingIn}
              className="owll-btn-primary w-full py-4 text-base flex items-center justify-center gap-3"
              style={{ background: accentGrad, boxShadow: accentShadow }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24">
                <path fill="#5B67F0" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                <path fill="#5B67F0" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#5B67F0" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="#5B67F0" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              Sign in with Google
            </button>
          )}

          <p style={{ color: '#5C5856', fontSize: '0.78rem', marginTop: '1.5rem', fontFamily: 'Titillium Web, sans-serif' }}>
            By continuing you agree to our{' '}
            <button
              type="button"
              onClick={() => showStaticPage('terms')}
              style={{ color: '#FFFFFF', textDecoration: 'underline', background: 'transparent', border: 'none', padding: 0, font: 'inherit', cursor: 'pointer' }}
            >
              Terms
            </button>
            {' '}&amp;{' '}
            <button
              type="button"
              onClick={() => showStaticPage('privacy')}
              style={{ color: '#FFFFFF', textDecoration: 'underline', background: 'transparent', border: 'none', padding: 0, font: 'inherit', cursor: 'pointer' }}
            >
              Privacy Policy
            </button>
            .
          </p>
          <p style={{ color: '#5C5856', fontSize: '0.72rem', marginTop: '0.75rem', fontFamily: 'Titillium Web, sans-serif' }}>
            <button
              type="button"
              onClick={() => showStaticPage('delete-account')}
              style={{ color: '#8C8684', textDecoration: 'underline', background: 'transparent', border: 'none', padding: 0, font: 'inherit', cursor: 'pointer' }}
            >
              Request account deletion
            </button>
          </p>
        </motion.div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────
  // RECORDING
  // ─────────────────────────────────────────────────────────────
  if (isRecording) {
    return (
      <div className="owll-recording-bg min-h-screen flex flex-col">
        <div className="owll-bg" />

        <header className="px-6 py-5 flex items-center justify-between relative z-10" style={{ borderBottom: '1px solid rgba(78,78,78,0.4)' }}>
          <button
            onClick={stopRecording}
            aria-label="Stop recording and save"
            className="p-2 rounded-xl transition-colors hover:bg-white/5"
            style={{ color: '#8C8684' }}
          >
            <ChevronLeft size={22} />
          </button>
          <span style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 600, color: '#FFFFFF', fontSize: '0.95rem' }}>
            Recording…
          </span>
          <div className="w-9" />
        </header>

        <div className="flex-1 flex flex-col items-center justify-center relative z-10 gap-8">
          {/* Rings */}
          <div className="relative flex items-center justify-center">
            {[180, 220, 260].map((size, i) => (
              <motion.div
                key={i}
                animate={{ scale: [1, 1.1 + i * 0.05, 1], opacity: [0.18 - i * 0.04, 0.06, 0.18 - i * 0.04] }}
                transition={{ repeat: Infinity, duration: 2.4 + i * 0.3, ease: 'easeInOut', delay: i * 0.2 }}
                className="absolute rounded-full border"
                style={{ width: size, height: size, borderColor: 'rgba(255,255,255,0.35)' }}
              />
            ))}
            {/* Mic */}
            <div
              className="w-28 h-28 rounded-full flex items-center justify-center owll-mic-pulse"
              style={{ background: accentGrad, boxShadow: '0 0 50px rgba(91, 103, 240,0.5)' }}
            >
              <Mic size={44} color="#5B67F0" />
            </div>
          </div>

          <span
            style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '2.8rem', fontWeight: 700, color: '#FFFFFF', letterSpacing: '0.08em' }}
          >
            {fmt(recordingTime)}
          </span>
          <span style={{ color: '#8C8684', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.9rem' }}>
            Recording in progress
          </span>

          {recordingTime >= RECORDING_WARN_AFTER_SECONDS && (
            <div
              role="status"
              className="px-4 py-2 rounded-full mt-2"
              style={{
                background: 'rgba(255,255,255,0.12)',
                border: '1px solid rgba(255,255,255,0.4)',
                color: '#FFFFFF',
                fontFamily: 'Titillium Web, sans-serif',
                fontSize: '0.78rem',
                letterSpacing: '0.02em',
              }}
            >
              {capWarningText(Math.max(0, MAX_RECORDING_SECONDS - recordingTime))}
            </div>
          )}

          <div style={{ width: 'min(360px, 80vw)', marginTop: 8 }}>
            <Waveform stream={recordingStream} height={64} />
          </div>
        </div>

        <div className="owll-nav pb-12 px-16 flex justify-center items-center pt-8 relative z-10">
          <button onClick={stopRecording} aria-label="End recording" className="flex flex-col items-center gap-2">
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center transition-all hover:scale-105"
              style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)', color: '#EF4444' }}
            >
              <Square fill="currentColor" size={22} />
            </div>
            <span style={{ color: '#8C8684', fontSize: '0.75rem', fontFamily: 'Rajdhani, sans-serif', fontWeight: 600 }}>End</span>
          </button>
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────
  // NOTE DETAIL
  // ─────────────────────────────────────────────────────────────
  if (selectedNote) {
    return (
      <div className="min-h-screen flex flex-col" style={{ background: '#030303' }}>
        <div className="owll-bg" />
        <header
          className="owll-safe-top px-6 pb-5 space-y-4 relative z-10"
          style={{ background: 'linear-gradient(175deg,#131313,#050505)', borderBottom: '1px solid rgba(78,78,78,0.4)', borderBottomLeftRadius: '1.75rem', borderBottomRightRadius: '1.75rem' }}
        >
          <div className="flex justify-between items-center">
            <button
              onClick={() => setSelectedNote(null)}
              aria-label="Back to notes list"
              className="p-2 rounded-xl hover:bg-white/5 transition-colors"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(78,78,78,0.4)' }}
            >
              <ChevronLeft size={20} color="#FFFFFF" />
            </button>
            <h1 style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, color: '#FFFFFF', fontSize: '0.95rem', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selectedNote.title}
            </h1>
            <div className="flex items-center gap-2">
              {isEditingNote ? (
                <>
                  <button
                    onClick={cancelEditNote}
                    disabled={savingNote}
                    aria-label="Cancel editing"
                    className="p-2 rounded-xl hover:bg-white/10 transition-colors disabled:opacity-50"
                    style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(78,78,78,0.4)' }}
                  >
                    <X size={20} color="#FFFFFF" />
                  </button>
                  <button
                    onClick={handleSaveNote}
                    disabled={savingNote}
                    aria-label="Save changes"
                    className="p-2 rounded-xl transition-colors disabled:opacity-50"
                    style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.4)' }}
                  >
                    <Check size={20} color="#FFFFFF" />
                  </button>
                </>
              ) : (
                <>
                  {selectedNote.status === 'ready' && selectedNote.authorId === user.uid && (
                    <button
                      onClick={beginEditNote}
                      aria-label="Edit note"
                      className="p-2 rounded-xl hover:bg-white/10 transition-colors"
                      style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(78,78,78,0.4)' }}
                    >
                      <Pencil size={20} color="#FFFFFF" />
                    </button>
                  )}
                  <button
                    onClick={() => {
                      // generatePDF dynamically imports jspdf. After a redeploy
                      // the old hashed chunk 404s, and uncaught that meant the
                      // Download button silently did nothing, forever, until a
                      // reload — with no clue why.
                      void generatePDF(selectedNote).catch((err) => {
                        console.error('pdf_export_failed', err);
                        alert('Could not build the PDF. Please refresh the page and try again.');
                      });
                    }}
                    aria-label="Download as PDF"
                    className="p-2 rounded-xl hover:bg-white/10 transition-colors"
                    style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(78,78,78,0.4)' }}
                  >
                    <Download size={20} color="#FFFFFF" />
                  </button>
                  {/* A10 #4 — report a bad summary/transcript. The kind follows
                      the tab the user is looking at; only the note id travels
                      with it, never the summary/transcript content itself. */}
                  {selectedNote.status === 'ready' && (
                    <button
                      onClick={() => {
                        setSupportKind(noteView === 'transcript' ? 'bad_transcript' : 'bad_summary');
                        setSupportNoteId(selectedNote.id);
                        setShowSupport(true);
                      }}
                      aria-label={noteView === 'transcript' ? 'Report a bad transcript' : 'Report a bad summary'}
                      className="p-2 rounded-xl hover:bg-white/10 transition-colors"
                      style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(78,78,78,0.4)' }}
                    >
                      <Flag size={20} color="#FFFFFF" />
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
          <div className="flex gap-3 relative z-10">
            <button
              onClick={() => setNoteView('summary')}
              disabled={isEditingNote}
              className="flex-1 py-2.5 rounded-xl text-sm font-bold transition-all disabled:opacity-60"
              style={{
                fontFamily: 'Rajdhani, sans-serif',
                background: noteView === 'summary' ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.04)',
                border: noteView === 'summary' ? '1px solid rgba(255,255,255,0.35)' : '1px solid rgba(78,78,78,0.45)',
                color: noteView === 'summary' ? '#FFFFFF' : '#8C8684',
              }}
            >
              Summary
            </button>
            <button
              onClick={() => setNoteView('transcript')}
              disabled={isEditingNote}
              className="flex-1 py-2.5 rounded-xl text-sm font-bold transition-all disabled:opacity-60"
              style={{
                fontFamily: 'Rajdhani, sans-serif',
                background: noteView === 'transcript' ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.04)',
                border: noteView === 'transcript' ? '1px solid rgba(255,255,255,0.35)' : '1px solid rgba(78,78,78,0.45)',
                color: noteView === 'transcript' ? '#FFFFFF' : '#8C8684',
              }}
            >
              Transcript
            </button>
          </div>
        </header>

        <div className="flex-1 p-5 overflow-y-auto space-y-4 relative z-10">
          {selectedNote.status !== 'ready' && selectedNote.status !== 'error' && selectedNote.status !== 'recording' ? (
            <div className="flex flex-col items-center justify-center py-24 gap-4">
              <Bot size={48} color="#FFFFFF" className="animate-bounce" />
              <JobStatus workspaceId={selectedNote.workspaceId} noteId={selectedNote.id} />
              <p style={{ color: '#8C8684', fontFamily: 'Titillium Web, sans-serif' }}>
                {uploadProgress > 0 && uploadProgress < 100
                  ? `Uploading audio… ${uploadProgress}%`
                  : slowNoteIds.has(selectedNote.id)
                    ? "Taking longer than usual. It's still running, and this page updates when it's ready."
                    : 'Working on it. This page updates live.'}
              </p>
            </div>
          ) : selectedNote.status === 'error' ? (
            <div className="flex flex-col items-center justify-center py-24 gap-4 px-6 text-center">
              <Bot size={48} color="#EF4444" />
              <p style={{ color: '#E5E0DF', fontFamily: 'Rajdhani, sans-serif', fontWeight: 700 }}>
                Processing failed
              </p>
              <p style={{ color: '#8C8684', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.88rem' }}>
                {selectedNote.errorMessage || "We couldn't analyse this recording. Please try again."}
              </p>
              <button
                onClick={() => retryProcessing(selectedNote)}
                className="owll-btn-primary mt-2 px-6 py-3 text-sm inline-flex items-center gap-2"
                style={{ background: accentGrad, boxShadow: accentShadow }}
                aria-label="Retry processing"
              >
                <RotateCcw size={16} />
                Try again
              </button>
            </div>
          ) : isEditingNote && editDraft ? (
            <>
              {/* ── Title ── */}
              <div className="owll-card p-5 space-y-3">
                <h3 style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#FFFFFF' }}>Title</h3>
                <input
                  value={editDraft.title}
                  onChange={(e) => setEditDraft((d) => (d ? { ...d, title: e.target.value } : d))}
                  className="w-full bg-transparent outline-none rounded-lg px-3 py-2"
                  style={{ color: '#E5E0DF', fontFamily: 'Titillium Web, sans-serif', border: '1px solid rgba(78,78,78,0.45)' }}
                  placeholder="Note title"
                />
              </div>

              {/* ── Executive Summary ── */}
              <div className="owll-card p-5 space-y-3">
                <h3 style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#FFFFFF' }}>Executive Summary</h3>
                <textarea
                  value={editDraft.gist}
                  onChange={(e) => setEditDraft((d) => (d ? { ...d, gist: e.target.value } : d))}
                  rows={5}
                  className="w-full bg-transparent outline-none rounded-lg px-3 py-2 resize-y"
                  style={{ color: '#E5E0DF', lineHeight: 1.7, fontFamily: 'Titillium Web, sans-serif', border: '1px solid rgba(78,78,78,0.45)' }}
                  placeholder="Summary of the meeting"
                />
              </div>

              {/* ── Action Items / Key Decisions (editable lists) ── */}
              {([
                { key: 'actionItems' as const, label: 'Action Items', placeholder: 'Action item' },
                { key: 'keyDecisions' as const, label: 'Key Decisions', placeholder: 'Key decision' },
              ]).map(({ key, label, placeholder }) => (
                <div key={key} className="owll-card p-5 space-y-3">
                  <h3 style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#FFFFFF' }}>{label}</h3>
                  <div className="space-y-2">
                    {editDraft[key].map((val, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input
                          value={val}
                          onChange={(e) => {
                            const v = e.target.value;
                            updateDraftList(key, (list) => list.map((x, j) => (j === i ? v : x)));
                          }}
                          className="flex-1 bg-transparent outline-none rounded-lg px-3 py-2"
                          style={{ color: '#E5E0DF', fontFamily: 'Titillium Web, sans-serif', border: '1px solid rgba(78,78,78,0.45)' }}
                          placeholder={placeholder}
                        />
                        <button
                          onClick={() => updateDraftList(key, (list) => list.filter((_, j) => j !== i))}
                          aria-label={`Remove ${placeholder.toLowerCase()}`}
                          className="p-2 rounded-lg hover:bg-white/5 transition-colors flex-shrink-0"
                          style={{ border: '1px solid rgba(78,78,78,0.45)' }}
                        >
                          <Trash2 size={16} color="#8C8684" />
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={() => updateDraftList(key, (list) => [...list, ''])}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold"
                      style={{ fontFamily: 'Rajdhani, sans-serif', background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.35)', color: '#FFFFFF' }}
                    >
                      <Plus size={14} /> Add {label.replace(/s$/, '')}
                    </button>
                  </div>
                </div>
              ))}
            </>
          ) : noteView === 'summary' ? (
            <>
              {[
                { label: 'Executive Summary', content: <p style={{ color: '#E5E0DF', lineHeight: 1.7, fontFamily: 'Titillium Web, sans-serif' }}>{selectedNote.summary?.gist}</p> },
                {
                  label: 'Action Items',
                  content: (
                    <ul className="space-y-3">
                      {selectedNote.summary?.actionItems?.map((item, i) => (
                        <li key={i} className="flex gap-3" style={{ color: '#E5E0DF', fontFamily: 'Titillium Web, sans-serif' }}>
                          <div className="w-5 h-5 rounded flex-shrink-0 mt-0.5" style={{ border: '2px solid rgba(255,255,255,0.4)' }} />
                          {item}
                        </li>
                      ))}
                    </ul>
                  )
                },
                {
                  label: 'Key Decisions',
                  content: (
                    <ul className="space-y-3">
                      {selectedNote.summary?.keyDecisions?.map((item, i) => (
                        <li key={i} className="flex gap-3" style={{ color: '#E5E0DF', fontFamily: 'Titillium Web, sans-serif' }}>
                          <div className="w-2 h-2 rounded-full mt-2 flex-shrink-0" style={{ background: '#FFFFFF' }} />
                          {item}
                        </li>
                      ))}
                    </ul>
                  )
                },
              ].map(({ label, content }) => (
                <div key={label} className="owll-card p-5 space-y-3">
                  <h3 style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#FFFFFF' }}>{label}</h3>
                  {content}
                </div>
              ))}
            </>
          ) : (
            <div className="owll-card p-5 space-y-4">
              <h3 style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#FFFFFF' }}>Full Transcript</h3>
              {selectedNote.transcript && selectedNote.transcript.length > 0 ? (
                selectedNote.transcript.map((line, i) => (
                  <div key={i} className="space-y-1 pb-3" style={{ borderBottom: i < selectedNote.transcript!.length - 1 ? '1px solid rgba(78,78,78,0.2)' : 'none' }}>
                    <div className="flex items-center gap-2">
                      <span style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, color: '#FFFFFF', fontSize: '0.85rem' }}>{line.speaker}</span>
                      <span style={{ color: '#5C5856', fontSize: '0.75rem', fontFamily: 'Titillium Web, sans-serif' }}>{line.time}</span>
                    </div>
                    <p style={{ color: '#E5E0DF', lineHeight: 1.6, fontFamily: 'Titillium Web, sans-serif', fontSize: '0.9rem' }}>{line.text}</p>
                  </div>
                ))
              ) : (
                <p style={{ color: '#8C8684', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.9rem' }}>No transcript available.</p>
              )}
            </div>
          )}
        </div>

        {/* Paywall / account prompt can be triggered while a note is open
            (first-summary view, or a 402 during processing), so they render
            here too — the note-detail view returns before the home tree. */}
        {billingModals}
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────
  // HOME
  // ─────────────────────────────────────────────────────────────
  type HomeAction = { type: NoteType; title: string; sub: string; tags?: string[]; Icon: any };
  const actions: HomeAction[] = ([
    { type: 'recording',     title: 'Instant Recorder',      sub: 'Record and generate a short summary',    tags: ['Meetings','Lecture','Forum'], Icon: Mic   },
    { type: 'import_audio',  title: 'Import Files',          sub: 'Import audio and YouTube links',           tags: ['Audio','YouTube'], Icon: Plus  },
    { type: 'online_meeting',title: 'Record Online Meeting', sub: 'Google Meet and Microsoft Teams',         Icon: Bot  },
    { type: 'scan_text',     title: 'Scan Text',             sub: 'Read images, PDF, Word and create PDFs', tags: ['Image','PDF','DOCX'], Icon: Scan },
  ] satisfies HomeAction[]).filter(
    // The web client is read-only and cannot capture another app's system audio,
    // so it must not advertise online-meeting recording (A6.6 / ADR 0002).
    (a) => !(platform === 'web' && a.type === 'online_meeting'),
  );

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#030303', fontFamily: 'Titillium Web, sans-serif' }}>
      <div className="owll-bg" />

      {/* Ambient equalizer backdrop — global, behind every tab */}
      <EqualizerBg />

      <main className="flex-1 pb-28 overflow-y-auto relative z-10">

        {activeTab === 'home' && (
          <>
            {/* ── Header ── */}
            <div className="owll-header owll-safe-top-lg px-6 text-white relative">
              <div className="flex justify-between items-center mb-8">
                {/* Wordmark + logo */}
                <div className="flex items-center gap-3">
                  <img
                    src="/logo.png"
                    alt="AlgoMinutes"
                    className="h-9 w-auto"
                    style={{ filter: 'drop-shadow(0 0 14px rgba(91, 103, 240,0.65))' }}
                  />
                  <span
                    className="owll-wordmark"
                    style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 900, fontSize: '1.75rem', letterSpacing: '-0.015em' }}
                  >
                    AlgoMinutes
                  </span>
                </div>

                {/* A9.5 web upgrade entry point. Stripe on the web is not subject
                    to the App Store IAP restriction that gated the native
                    button, so the paywall is reachable here directly. Hidden
                    once the user is already on Pro. */}
              {platform === 'web' && entitlement?.state !== 'active' && (
                <button
                  onClick={() => openPaywall('manual')}
                  className="px-4 py-2 rounded-xl text-xs font-bold"
                  style={{ background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.35)', color: '#FFFFFF', fontFamily: 'Rajdhani, sans-serif' }}
                >
                  Upgrade
                </button>
              )}
              </div>

              {/* Greeting */}
              <p style={{ color: '#8C8684', fontSize: '0.85rem', fontFamily: 'Titillium Web, sans-serif', marginBottom: '0.2rem' }}>
                Welcome back!
              </p>
              <h2 style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, fontSize: '1.35rem', color: '#FFFFFF' }}>
                {user.displayName?.split(' ')[0] ?? 'there'}
              </h2>
            </div>

            {/* ── A9.3 reverse-trial banner (countdown from trialEndsAt) ── */}
            <TrialBanner entitlement={entitlement} onUpgrade={() => openPaywall('trial')} />

            {/* ── Broadcast active banner ── */}
            {isBroadcasting && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="mx-5 mb-3 p-4 rounded-2xl flex items-center justify-between"
                style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)' }}
              >
                <div className="flex items-center gap-3">
                  <div className="w-3 h-3 rounded-full bg-red-500 animate-pulse" />
                  <div>
                    <p style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, color: '#FFFFFF', fontSize: '0.9rem' }}>
                      {broadcastState === 'starting' ? 'Waiting for broadcast…' : 'Recording Meeting'}
                    </p>
                    <p style={{ color: '#8C8684', fontSize: '0.78rem', fontFamily: 'Titillium Web, sans-serif' }}>
                      {broadcastState === 'starting'
                        ? platform === 'android'
                          ? 'Approve Android screen/audio capture'
                          : 'Tap "Start Broadcast" in the iOS sheet'
                        : platform === 'android'
                          ? `${fmt(broadcastSeconds)} — Stop from the AlgoMinutes notification`
                          : `${fmt(broadcastSeconds)} — Tap the red bar at the top to stop`}
                    </p>
                  </div>
                </div>
                <button
                  onClick={async () => {
                    try {
                      const status = await BroadcastRecorder.getStatus();
                      if (status.hasCompletedRecording) {
                        handleBroadcastComplete();
                      } else if (status.state === 'recording') {
                        if (platform === 'android' && BroadcastRecorder.stopBroadcast) {
                          await BroadcastRecorder.stopBroadcast();
                        } else {
                          alert('Tap the red status bar at the top of your screen to stop the broadcast.');
                        }
                      } else if (status.state === 'starting') {
                        alert(platform === 'android'
                          ? 'Approve Android screen/audio capture, then switch to your meeting app.'
                          : 'Tap "Start Broadcast" in the iOS sheet, then switch to your meeting app.');
                      } else {
                        // Stuck — let user reset
                        await BroadcastRecorder.clearRecording();
                        safeSetState(setBroadcastState, 'idle');
                        safeSetState(setBroadcastDurationMs, 0);
                      }
                    } catch (err) {
                      console.warn('broadcast_check_failed', err);
                    }
                  }}
                  className="px-4 py-2 rounded-xl text-xs font-bold"
                  style={{ background: 'rgba(239,68,68,0.2)', color: '#EF4444', border: '1px solid rgba(239,68,68,0.4)', fontFamily: 'Rajdhani, sans-serif' }}
                >
                  Check
                </button>
              </motion.div>
            )}

            {/* ── Action cards ── */}
            <div className="px-5 -mt-6 space-y-3.5 relative z-10">
              {actions.map(({ type, title, sub, tags, Icon }, idx) => (
                <motion.button
                  key={type}
                  onClick={() => startAction(type)}
                  whileTap={{ scale: 0.985 }}
                  initial={{ opacity: 0, y: 18 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.05 + idx * 0.07, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                  className="w-full owll-card p-5 flex items-center justify-between text-left group"
                >
                  <div className="relative z-10 flex-1 mr-4">
                    <h3 style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, fontSize: '1.08rem', color: '#FFFFFF', marginBottom: '0.25rem' }}>
                      {title}
                    </h3>
                    <p style={{ fontSize: '0.83rem', color: '#8C8684', marginBottom: tags ? '0.85rem' : 0 }}>
                      {sub}
                    </p>
                    {tags && (
                      <div className="flex gap-2 flex-wrap">
                        {tags.map(t => <span key={t} className="owll-tag">{t}</span>)}
                      </div>
                    )}
                  </div>
                  <div className="w-14 h-14 owll-icon-btn">
                    <Icon size={24} />
                  </div>
                </motion.button>
              ))}
            </div>

            {/* ── Recent notes ── */}
            {notes.length > 0 && (
              <div className="px-5 mt-8">
                <div className="flex items-center justify-between mb-4">
                  <h3 style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, color: '#FFFFFF', fontSize: '1rem' }}>Recent Notes</h3>
                  <button onClick={() => setActiveTab('folder')} style={{ color: '#FFFFFF', fontSize: '0.8rem', fontFamily: 'Titillium Web, sans-serif' }} className="flex items-center gap-1">
                    See all <ChevronRight size={14} />
                  </button>
                </div>
                <div className="space-y-3">
                  {notes.slice(0, 5).map(note => (
                    <div
                      key={note.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`Open note ${note.title}`}
                      onClick={() => setSelectedNote(note)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelectedNote(note);
                        }
                      }}
                      className="owll-note-row p-4 flex items-center justify-between cursor-pointer"
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                          style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.22)' }}
                        >
                          <FileText size={18} color="#FFFFFF" />
                        </div>
                        <div>
                          <h4 style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 600, color: '#FFFFFF', fontSize: '0.88rem' }}>{note.title}</h4>
                          <p style={{ color: '#8C8684', fontSize: '0.75rem', fontFamily: 'Titillium Web, sans-serif', marginTop: '0.1rem' }}>
                            {new Date(note.createdAt).toLocaleDateString()}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {note.status !== 'ready' && note.status !== 'error' && (
                          <div className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
                        )}
                        {note.status === 'ready'      && <div className="w-2 h-2 rounded-full bg-emerald-400" />}
                        {note.status === 'error'      && <div className="w-2 h-2 rounded-full bg-red-500" />}
                        <ChevronRight size={16} color="#5C5856" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {activeTab === 'folder' && (
          <div className="px-6 pt-12 relative z-10">
            <h2 style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, fontSize: '1.35rem', color: '#FFFFFF', marginBottom: '1.5rem' }}>All Notes</h2>
            <div className="space-y-3">
              {notes.map(note => (
                <div
                  key={note.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open note ${note.title}`}
                  onClick={() => setSelectedNote(note)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedNote(note);
                    }
                  }}
                  className="owll-note-row p-4 flex items-center justify-between cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                      style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.22)' }}
                    >
                      <FileText size={18} color="#FFFFFF" />
                    </div>
                    <div>
                      <h4 style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 600, color: '#FFFFFF', fontSize: '0.88rem' }}>{note.title}</h4>
                      <p style={{ color: '#8C8684', fontSize: '0.75rem', fontFamily: 'Titillium Web, sans-serif', marginTop: '0.1rem' }}>
                        {new Date(note.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {note.status === 'processing' && <div className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />}
                    {note.status === 'ready'      && <div className="w-2 h-2 rounded-full bg-emerald-400" />}
                    <ChevronRight size={16} color="#5C5856" />
                  </div>
                </div>
              ))}
              {/* A listener failure is not the same as having no notes. */}
              {notesError && (
                <div className="owll-card flex flex-col items-center text-center px-6 py-8 mt-8" style={{ gap: '0.6rem' }}>
                  <AlertCircle size={22} color="#E0A44A" />
                  <p style={{ color: '#E5E0DF', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.85rem', maxWidth: 300 }}>
                    {notesError}
                  </p>
                </div>
              )}
              {!notesLoaded && !notesError && (
                <div className="owll-card flex items-center justify-center px-6 py-10 mt-8">
                  <p style={{ color: '#8C8684', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.85rem' }}>
                    Loading your notes…
                  </p>
                </div>
              )}
              {notesLoaded && !notesError && notes.length === 0 && (
                <div className="owll-card flex flex-col items-center text-center px-6 py-10 mt-8" style={{ gap: '0.85rem' }}>
                  <div
                    className="w-14 h-14 rounded-2xl flex items-center justify-center"
                    style={{ background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.35)' }}
                  >
                    <FileText size={26} color="#FFFFFF" />
                  </div>
                  <h3 style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, color: '#FFFFFF', fontSize: '1.05rem' }}>
                    No notes yet
                  </h3>
                  <p style={{ color: '#8C8684', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.85rem', lineHeight: 1.5, maxWidth: 280 }}>
                    Tap a recording option on the home screen and your transcript and summary will appear here.
                  </p>
                  <button
                    type="button"
                    onClick={() => setActiveTab('home')}
                    className="owll-btn-primary px-5 py-2.5 text-sm mt-1"
                    style={{ background: accentGrad, boxShadow: accentShadow }}
                  >
                    Go to home
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Contained, so a render throw over server data cannot unmount the
            whole tree — which includes the recording screen. */}
        {activeTab === 'search' && (
          <SurfaceBoundary name="search">
            <SearchTab
              notes={notes}
              onBack={() => setActiveTab('home')}
              onOpenNote={(noteId) => {
                const found = notes.find((n) => n.id === noteId);
                if (found) setSelectedNote(found);
              }}
            />
          </SurfaceBoundary>
        )}

        {activeTab === 'chat' && (
          <SurfaceBoundary name="chat">
            <ChatTab
              notes={notes}
              onBack={() => setActiveTab('home')}
              onOpenNote={(noteId) => {
                const found = notes.find((n) => n.id === noteId);
                if (found) setSelectedNote(found);
              }}
            />
          </SurfaceBoundary>
        )}

        {activeTab === 'users' && (
          <div className="px-6 pt-12 flex flex-col items-center justify-center text-center h-64 relative z-10">
            <Users size={48} color="#FFFFFF" className="mb-4 opacity-50" />
            <h2 style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, fontSize: '1.35rem', color: '#FFFFFF' }}>Team Workspace</h2>
            <p style={{ color: '#8C8684', fontFamily: 'Titillium Web, sans-serif', marginTop: '0.5rem' }}>Coming soon. Invite team members to collaborate.</p>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="px-6 pt-12 relative z-10">
             <div className="flex items-center gap-2" style={{ marginBottom: '2rem' }}>
               <button
                 onClick={() => setActiveTab('home')}
                 aria-label="Back to home"
                 className="p-2 rounded-xl transition-colors hover:bg-white/5"
                 style={{ color: '#8C8684', marginLeft: '-0.5rem' }}
               >
                 <ChevronLeft size={22} />
               </button>
               <h2 style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, fontSize: '1.35rem', color: '#FFFFFF' }}>Settings</h2>
             </div>
             
             <div className="owll-card p-5 space-y-4">
               <div className="flex justify-between items-center">
                 <span style={{ color: '#E5E0DF', fontFamily: 'Titillium Web, sans-serif' }}>Account</span>
                 <span style={{ color: '#8C8684', fontSize: '0.85rem' }}>{user.isAnonymous ? 'Guest' : user.email}</span>
               </div>
               {user.isAnonymous && (
                 <button
                   onClick={() => setShowAccountPrompt(true)}
                   className="w-full py-3 mt-1 rounded-xl text-sm font-bold"
                   style={{ background: accentGrad, boxShadow: accentShadow, color: '#0a0a0a', fontFamily: 'Rajdhani, sans-serif' }}
                 >
                   Create an account to save your work
                 </button>
               )}
               <div className="flex justify-between items-center pt-4" style={{ borderTop: '1px solid rgba(78,78,78,0.3)' }}>
                 <span style={{ color: '#E5E0DF', fontFamily: 'Titillium Web, sans-serif' }}>Workspace ID</span>
                 <span style={{ color: '#8C8684', fontSize: '0.75rem' }}>{workspaceId(user.uid)}</span>
               </div>
             </div>

             {/* A10 #5 — note-retention picker. */}
             <RetentionSetting />

             {/* A10 #4 — Help & support + report a problem. */}
             <div className="owll-card p-5 space-y-3 mt-4">
               <button
                 type="button"
                 onClick={() => { setSupportKind('contact'); setSupportNoteId(undefined); setShowSupport(true); }}
                 className="w-full flex justify-between items-center cursor-pointer"
                 style={{ color: '#E5E0DF', fontFamily: 'Titillium Web, sans-serif', textDecoration: 'none', background: 'transparent', border: 'none', padding: 0, textAlign: 'left' }}
               >
                 <span className="flex items-center gap-2"><LifeBuoy size={16} color="#8C8684" /> Help &amp; support</span>
                 <ChevronRight size={16} color="#8C8684" />
               </button>
             </div>

             <div className="owll-card p-5 space-y-3 mt-4">
               <button
                 type="button"
                 onClick={() => showStaticPage('privacy')}
                 className="w-full flex justify-between items-center cursor-pointer"
                 style={{ color: '#E5E0DF', fontFamily: 'Titillium Web, sans-serif', textDecoration: 'none', background: 'transparent', border: 'none', padding: 0, textAlign: 'left' }}
               >
                 <span>Privacy Policy</span>
                 <ChevronRight size={16} color="#8C8684" />
               </button>
               <button
                 type="button"
                 onClick={() => showStaticPage('terms')}
                 className="w-full flex justify-between items-center pt-3 cursor-pointer"
                 style={{ color: '#E5E0DF', fontFamily: 'Titillium Web, sans-serif', textDecoration: 'none', borderTop: '1px solid rgba(78,78,78,0.3)', background: 'transparent', border: 'none', padding: '0.75rem 0 0 0', textAlign: 'left', width: '100%' }}
               >
                 <span>Terms of Service</span>
                 <ChevronRight size={16} color="#8C8684" />
               </button>
             </div>

             {isAdmin(user) && <AdminCostsCard notes={notes} />}

             <button
               onClick={() => { void signOut(auth).catch((err) => console.error('signout_failed', err)); }}
               className="w-full py-4 mt-6 rounded-xl font-bold transition-colors cursor-pointer"
               style={{ background: 'rgba(239,68,68,0.1)', color: '#EF4444', border: '1px solid rgba(239,68,68,0.3)', fontFamily: 'Rajdhani, sans-serif' }}
             >
               Sign Out
             </button>

             <button
               onClick={() => setShowDeleteConfirm(true)}
               className="w-full py-4 mt-3 rounded-xl font-bold transition-colors cursor-pointer"
               style={{ background: 'transparent', color: '#EF4444', border: '1px solid rgba(239,68,68,0.45)', fontFamily: 'Rajdhani, sans-serif' }}
             >
               Delete my account
             </button>
          </div>
        )}
      </main>

      {/* ── Bottom nav ── */}
      <nav className="owll-nav fixed bottom-0 w-full flex justify-around items-center py-4 px-6 z-40">
        {[
          { id: 'home',   Icon: Home,           tab: 'home',   label: 'Home'   },
          { id: 'folder', Icon: Folder,         tab: 'folder', label: 'Files'  },
          { id: 'search', Icon: Search,         tab: 'search', label: 'Search' },
          { id: 'chat',   Icon: MessageSquare,  tab: 'chat',   label: 'Ask AI' },
        ].map(({ id, Icon, tab, label }) => (
          <button
            key={id}
            id={`nav-${id}`}
            onClick={() => setActiveTab(tab)}
            aria-label={label}
            aria-current={activeTab === tab ? 'page' : undefined}
            className="flex flex-col items-center justify-center"
            style={{ minWidth: 44, minHeight: 44 }}
          >
            <Icon
              size={26}
              aria-hidden="true"
              fill={activeTab === tab ? 'currentColor' : 'none'}
              style={{ color: activeTab === tab ? '#FFFFFF' : '#5C5856', transition: 'color 0.18s' }}
            />
          </button>
        ))}
        <button
          id="nav-settings"
          onClick={() => setActiveTab('settings')}
          aria-label="Settings"
          aria-current={activeTab === 'settings' ? 'page' : undefined}
          className="flex flex-col items-center justify-center"
          style={{ minWidth: 44, minHeight: 44 }}
        >
          <Settings
            size={26}
            aria-hidden="true"
            fill={activeTab === 'settings' ? 'currentColor' : 'none'}
            style={{ color: activeTab === 'settings' ? '#FFFFFF' : '#5C5856', transition: 'color 0.18s' }}
          />
        </button>
      </nav>

      {/* ── Broadcast instruction sheet (consent + 3-step guide) ── */}
      <BroadcastInstructionSheet
        open={showBroadcastInstructions}
        platform={platform}
        onCancel={() => {
          setShowBroadcastInstructions(false);
          safeSetState(setPendingNoteType, null);
        }}
        onContinue={continueAfterInstructions}
      />

      {/* ── Instant Recorder consent sheet (mic capture disclosure) ── */}
      <InstantRecorderConsent
        open={showInstantConsent}
        onCancel={() => {
          setShowInstantConsent(false);
          safeSetState(setPendingNoteType, null);
        }}
        onContinue={() => {
          setShowInstantConsent(false);
          beginSession();
        }}
      />

      {/* ── Delete-account confirmation (Apple App Store + GDPR compliance) ── */}
      <DeleteAccountConfirmation
        open={showDeleteConfirm}
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={async () => {
          const resp = await authedFetch('/api/delete-account', {});
          if (!resp.ok) {
            const body = await readErrorText(resp);
            console.error('delete_account_http_error', resp.status, body);
            throw new Error(`delete_account_failed_${resp.status}`);
          }
          // Cloud Function deleted Postgres rows + Firestore notes + Auth user.
          // signOut will trigger onAuthStateChanged → user=null → routes back to login.
          await signOut(auth);
        }}
      />

      {/* ── A10 #4 Help / support / feedback sheet ── */}
      <HelpSupportSheet
        open={showSupport}
        onClose={() => setShowSupport(false)}
        initialKind={supportKind}
        noteId={supportNoteId}
      />

      {/* ── Scan sheet (OCR + document text + image PDF) ── */}
      <AnimatePresence>
        {showScanSheet && (
          <div className="fixed inset-0 z-50 flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}>
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 32, stiffness: 320 }}
              className="owll-sheet w-full p-6 pb-14"
            >
              <div className="w-10 h-1 rounded-full mx-auto mb-6" style={{ background: 'rgba(255,255,255,0.16)' }} />
              <ScanPanel
                busyLabel={scanBusyLabel}
                onImportDocument={processDocumentTextFile}
                onImagesToPdf={createPdfFromImages}
                onCancel={() => {
                  if (scanBusyLabel) return;
                  setShowScanSheet(false);
                  setPendingNoteType(null);
                }}
              />
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── Import sheet (file + YouTube) ── */}
      <AnimatePresence>
        {showImportSheet && (
          <div className="fixed inset-0 z-50 flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}>
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 32, stiffness: 320 }}
              className="owll-sheet w-full p-6 pb-14"
            >
              <div className="w-10 h-1 rounded-full mx-auto mb-6" style={{ background: 'rgba(255,255,255,0.12)' }} />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
                <h2 style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, fontSize: '1.15rem', color: '#FFFFFF' }}>
                  Import audio
                </h2>
                <button
                  onClick={() => { setShowImportSheet(false); setPendingNoteType(null); }}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#8C8684', padding: 4, display: 'inline-flex' }}
                  aria-label="Close"
                >
                  <X size={20} />
                </button>
              </div>

              <div className="space-y-4">
                <ImportPanel
                  user={user}
                  onCreated={(note) => {
                    setSelectedNote(note);
                    setShowImportSheet(false);
                    setPendingNoteType(null);
                  }}
                  onCancel={() => {
                    setShowImportSheet(false);
                    setPendingNoteType(null);
                  }}
                />
                <YouTubeImport
                  user={user}
                  onCreated={(note) => {
                    setSelectedNote(note);
                    setShowImportSheet(false);
                    setPendingNoteType(null);
                  }}
                />
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── Preferences sheet ── */}
      <AnimatePresence>
        {showPreferences && (
          <div className="fixed inset-0 z-50 flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}>
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 32, stiffness: 320 }}
              className="owll-sheet w-full p-6 pb-14"
            >
              {/* Handle */}
              <div className="w-10 h-1 rounded-full mx-auto mb-6" style={{ background: 'rgba(255,255,255,0.12)' }} />

              <h2 style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, fontSize: '1.15rem', color: '#FFFFFF', marginBottom: '0.75rem' }}>
                Ready to record?
              </h2>

              <p style={{ fontFamily: 'Titillium Web, sans-serif', fontSize: '0.88rem', color: '#8C8684', lineHeight: 1.55, marginBottom: '1.5rem' }}>
                AlgoMinutes records audio from this device for as long as you're recording. The audio is uploaded to be transcribed and summarised, then kept in your account until you delete it. You can stop at any time.
              </p>

              <div className="flex gap-3">
                <button
                  onClick={() => setShowPreferences(false)}
                  className="owll-btn-ghost px-6 py-4 text-sm"
                >
                  Cancel
                </button>
                <button
                  onClick={() => { setShowPreferences(false); setShowInstantConsent(true); }}
                  className="owll-btn-primary flex-1 py-4 text-sm"
                  style={{ background: accentGrad, boxShadow: accentShadow }}
                >
                  Continue
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── A9.5 paywall + A6.3 account prompt ── */}
      {billingModals}
    </div>
  );
}
