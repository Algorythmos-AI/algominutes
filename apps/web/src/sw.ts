/// <reference lib="webworker" />
// The web app's service worker, at /app/sw.js (scope /app/): push notifications
// through Firebase Cloud Messaging. FCM shows a notification while the app
// isn't in front (in front, the page shows it: lib/push). Tapping one opens its
// note. Built on its own as one classic script (vite.sw.config.ts), because
// Firefox doesn't run module service workers. It caches nothing.
import { initializeApp } from 'firebase/app';
import { getMessaging } from 'firebase/messaging/sw';
import { noteUrl } from './lib/push/noteLink';

declare const self: ServiceWorkerGlobalScope;

// A new version takes over at once: there's no cache for an old page to depend on.
self.addEventListener('install', () => void self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Added before Firebase's own listener (getMessaging below adds it), and stops it: we open the note, relative
// to our scope, where Firebase would follow the payload's link.
self.addEventListener('notificationclick', (event) => {
  event.stopImmediatePropagation();
  event.notification.close();
  const url = noteUrl(self.registration.scope, event.notification.data);
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = wins.find((w) => w.url.startsWith(self.registration.scope));
      if (open) {
        try {
          await (await open.focus()).navigate(url);
          return;
        } catch {
          // silent-catch-ok: a window this worker doesn't control can't be navigated; a new one opens instead.
        }
      }
      await self.clients.openWindow(url);
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
