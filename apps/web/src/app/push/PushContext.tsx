import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import pkg from '../../../package.json';
import { reportCrash } from '../../lib/crashReport';
import type { PushMessaging, PushPermission } from '../../lib/push/messaging';
import { useApi } from '../ApiContext';
import { useAuth } from '../auth/AuthContext';
import { useNotice } from '../Notice';
import { useNotes } from '../notes/NotesContext';

export type PushState = 'off' | 'loading' | PushPermission;

interface PushValue {
  /** 'off': this build has no push. Otherwise the browser's permission, once known. */
  state: PushState;
  /** Asks the browser (from a click), then registers this browser for the signed-in user. */
  enable(): Promise<void>;
}

const PushContext = createContext<PushValue>({ state: 'off', enable: async () => {} });

const DISMISSED = 'algominutes.pushPrompt.dismissed';

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED) === '1';
  } catch {
    // silent-catch-ok: storage blocked (a private window); the prompt just shows again next time.
    return false;
  }
}

/**
 * Push notifications for the signed-in user: "your note is ready", as on iOS.
 * The browser's own permission prompt only ever follows a click, from a card
 * shown once the user has a note (when a notification would first be useful)
 * or from Settings. With permission, this browser's token is registered for
 * whoever is signed in, on every page load (the api upserts it, re-homing a
 * token that changed hands). A push that arrives with the app in front shows
 * as a notice instead.
 */
export function PushProvider({ messaging, children }: { messaging: PushMessaging | null; children: ReactNode }) {
  const { user } = useAuth();
  const { api } = useApi();
  const { visible } = useNotes();
  const notice = useNotice();
  const [state, setState] = useState<PushState>(messaging ? 'loading' : 'off');
  const [hidden, setHidden] = useState(dismissed);
  const registeredFor = useRef<string | null>(null);
  const uid = user?.uid ?? null;

  useEffect(() => {
    if (!messaging) return;
    let live = true;
    messaging
      .permission()
      .then((p) => live && setState(p))
      .catch((err) => {
        if (live) setState('unsupported');
        reportCrash('push.permission', err);
      });
    return () => {
      live = false;
    };
  }, [messaging]);

  const register = useCallback(
    async (forUid: string) => {
      if (!messaging || registeredFor.current === forUid) return;
      registeredFor.current = forUid;
      try {
        const token = await messaging.token();
        await api.registerPush({ token, platform: 'web', appVersion: pkg.version });
      } catch (err) {
        registeredFor.current = null;
        reportCrash('push.register', err);
      }
    },
    [messaging, api],
  );

  useEffect(() => {
    if (state === 'granted' && uid) void register(uid);
    if (!uid) registeredFor.current = null;
  }, [state, uid, register]);

  useEffect(() => {
    if (!messaging || state !== 'granted') return;
    return messaging.onForeground((m) => {
      const text = [m.title, m.body].filter(Boolean).join(': ');
      if (text) notice.show(text);
    });
  }, [messaging, state, notice]);

  const enable = useCallback(async () => {
    if (!messaging) return;
    try {
      const p = await messaging.requestPermission();
      setState(p);
      if (p === 'denied') notice.show('Notifications are blocked for this site. You can allow them in your browser’s site settings.');
    } catch (err) {
      reportCrash('push.requestPermission', err);
      notice.show('Notifications couldn’t be turned on here.');
    }
  }, [messaging, notice]);

  const value = useMemo(() => ({ state, enable }), [state, enable]);
  const prompt = state === 'default' && uid !== null && visible.length > 0 && !hidden;
  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem(DISMISSED, '1');
    } catch {
      // silent-catch-ok: storage blocked; dismissed for this visit only.
    }
  };

  return (
    <PushContext.Provider value={value}>
      {children}
      {prompt && (
        <aside aria-label="Notifications" className="fixed inset-x-0 bottom-20 z-10 mx-auto w-[min(28rem,calc(100%-2rem))] rounded-2xl border border-border bg-card p-4 shadow-card">
          <p className="font-semibold text-heading">Know when a note is ready?</p>
          <p className="mt-1 text-body">AlgoMinutes can tell this browser when a recording has been summed up, or if something went wrong.</p>
          <div className="mt-3 flex gap-2">
            <button type="button" className="rounded-xl bg-accent px-4 py-2 font-semibold text-white" onClick={() => { dismiss(); void enable(); }}>
              Turn on notifications
            </button>
            <button type="button" className="px-4 py-2 text-muted" onClick={dismiss}>Not now</button>
          </div>
        </aside>
      )}
    </PushContext.Provider>
  );
}

export function usePush(): PushValue {
  return useContext(PushContext);
}
