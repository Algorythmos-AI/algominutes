/// <reference lib="webworker" />
// The web app's service worker, at /app/sw.js (scope /app/): push notifications
// through Firebase Cloud Messaging. It caches nothing. Built on its own as one
// classic script (vite.sw.config.ts), because Firefox doesn't run module
// service workers.
//
// It handles the notifier's notifications itself, ahead of Firebase's own
// listeners (which getMessaging adds, below): Firebase counts any visible
// window of the origin as "the app is in front", public-site pages included,
// and hands the push to the pages instead of showing it. Here only the app's
// own windows count. A tap asks the app to open the note (so a recording tab's
// "You're recording" guard still applies), or opens a new window.
import { initializeApp } from 'firebase/app';
import { getMessaging } from 'firebase/messaging/sw';
import { inApp, noteIdOf, noteUrl, parsePush, pickWindow, type WorkerMessage } from './lib/push/noteLink';

declare const self: ServiceWorkerGlobalScope;

// A new version takes over at once: there's no cache for an old page to depend on.
self.addEventListener('install', () => void self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const appWindows = async () => (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter((w) => inApp(w.url, self.registration.scope));

self.addEventListener('push', (event) => {
  let json: unknown = null;
  try {
    json = event.data?.json() ?? null;
  } catch {
    // silent-catch-ok: not JSON, so not the notifier's; Firebase's own listener gets it.
    return;
  }
  const notice = parsePush(json);
  if (!notice) return;
  event.stopImmediatePropagation();
  event.waitUntil(
    (async () => {
      const wins = await appWindows();
      if (wins.some((w) => w.visibilityState === 'visible')) {
        const msg: WorkerMessage = { type: 'algominutes:push', title: notice.title, body: notice.body, noteId: notice.noteId };
        wins.forEach((w) => w.postMessage(msg));
        return;
      }
      await self.registration.showNotification(notice.title, { body: notice.body, icon: `${self.registration.scope}icon-192.png`, data: { FCM_MSG: notice.raw } });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.stopImmediatePropagation();
  event.notification.close();
  const data: unknown = event.notification.data;
  event.waitUntil(
    (async () => {
      const win = pickWindow(await appWindows(), self.registration.scope);
      if (win) {
        const msg: WorkerMessage = { type: 'algominutes:open-note', noteId: noteIdOf(data) };
        win.postMessage(msg);
        try {
          await win.focus();
          return;
        } catch {
          // silent-catch-ok: a window may refuse focus; a new one opens instead.
        }
      }
      await self.clients.openWindow(noteUrl(self.registration.scope, data));
    })(),
  );
});

getMessaging(
  initializeApp({
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  }),
);
