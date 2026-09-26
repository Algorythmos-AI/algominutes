// Web push: Firebase Cloud Messaging in the page. The web twin of iOS's APNs
// registration (a token posted to /v1/push/register, which the notifier sends to).
//
// Behind an interface so the app is tested on a fake. The Firebase one loads
// firebase/messaging only when it's used, keeping it out of the first download,
// and exists only when the build has a VAPID key (VITE_FIREBASE_VAPID_KEY,
// Firebase → Cloud Messaging → Web Push certificates): without one, push is
// simply off. The service worker is ours, at /app/sw.js, never Firebase's
// default /firebase-messaging-sw.js (that path is outside the app).
import type { FirebaseApp } from 'firebase/app';
import type { AuthAdapter } from '../auth/adapter';
import { reportCrash } from '../crashReport';
import { noteIdOf } from './noteLink';

export type PushPermission = NotificationPermission | 'unsupported';

export interface ForegroundMessage {
  noteId: string | null;
  title: string | null;
  body: string | null;
}

export interface PushMessaging {
  /** The browser's answer so far, or 'unsupported' (no service workers or Push API here). */
  permission(): Promise<PushPermission>;
  /** Asks the browser (only from a click: browsers ignore or penalise a prompt without one). */
  requestPermission(): Promise<NotificationPermission>;
  /** This browser's FCM token, registering the service worker first. Needs permission. */
  token(): Promise<string>;
  /** Forgets this browser's token, so nothing more is delivered to it. A no-op if it never had one. */
  deleteToken(): Promise<void>;
  /** A push that arrives while the app is in front (FCM shows nothing then). */
  onForeground(cb: (m: ForegroundMessage) => void): () => void;
}

export function firebaseMessaging(vapidKey: string | undefined, app: () => FirebaseApp, base = import.meta.env.BASE_URL): PushMessaging | null {
  const key = (vapidKey ?? '').trim();
  if (!key) return null;
  const scope = new URL(base, location.origin).href;
  const browserCan = () => typeof Notification !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
  type Loaded = { mod: typeof import('firebase/messaging'); messaging: import('firebase/messaging').Messaging };
  let loaded: Promise<Loaded | null> | null = null;
  const load = () =>
    (loaded ??= import('firebase/messaging').then(async (mod) => ((await mod.isSupported()) ? { mod, messaging: mod.getMessaging(app()) } : null)));
  const need = async () => {
    const l = await load();
    if (!l) throw new Error('push: not supported in this browser');
    return l;
  };
  const bind = async (l: Loaded, reg: ServiceWorkerRegistration) => l.mod.getToken(l.messaging, { vapidKey: key, serviceWorkerRegistration: reg });

  return {
    permission: async () => (browserCan() && (await load()) ? Notification.permission : 'unsupported'),
    requestPermission: () => Notification.requestPermission(),
    token: async () => {
      const l = await need();
      const reg = await navigator.serviceWorker.register(`${base}sw.js`, { scope: base });
      return bind(l, reg);
    },
    deleteToken: async () => {
      if (!browserCan() || Notification.permission !== 'granted') return;
      const reg = await navigator.serviceWorker.getRegistration(scope);
      if (!reg) return;
      const l = await need();
      // deleteToken on a Messaging that hasn't been given our worker registers Firebase's default one
      // (/firebase-messaging-sw.js, a 404 here) and fails; getToken with ours binds it first.
      await bind(l, reg);
      await l.mod.deleteToken(l.messaging);
    },
    onForeground: (cb) => {
      let off: (() => void) | null = null;
      let stopped = false;
      load()
        .then((l) => {
          if (!l || stopped) return;
          off = l.mod.onMessage(l.messaging, (p) =>
            cb({ noteId: noteIdOf(p.data), title: p.notification?.title ?? null, body: p.notification?.body ?? null }),
          );
        })
        .catch((err) => reportCrash('push.onForeground', err));
      return () => {
        stopped = true;
        off?.();
      };
    },
  };
}

/**
 * The adapter, with sign-out first forgetting this browser's push token: the
 * next person to use the browser mustn't get the last one's notifications. A
 * failure there is reported but never stops the sign-out; the notifier also
 * prunes a token FCM says is dead.
 */
export function withPushSignOut(adapter: AuthAdapter, push: PushMessaging | null): AuthAdapter {
  if (!push) return adapter;
  return {
    ...adapter,
    signOut: async () => {
      try {
        await push.deleteToken();
      } catch (err) {
        reportCrash('push.deleteToken', err);
      }
      await adapter.signOut();
    },
  };
}
