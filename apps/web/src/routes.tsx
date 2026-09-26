import type { RouteObject } from 'react-router';
import { Shell } from './app/Shell';
import { RequireAuth } from './app/auth/RequireAuth';
import { SignInPage } from './app/auth/SignInPage';
import { NotFoundPage } from './app/pages';
import { NotesPage } from './app/notes/NotesPage';

// The first screens (sign-in, the notes list) are in the first download; every
// other page loads when it's first opened, which keeps that download inside the
// plan's 250 KB budget (scripts/check-web-bundle.mjs).
/** What shows while a page opened straight from the address bar is still loading. */
function Loading() {
  return (
    <p role="status" className="p-8 text-center text-muted">
      Loading…
    </p>
  );
}

const page = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) => async () => ({ Component: (await load())[name] });

/** The app's routes, under the router's basename (/app). Each feature PR (plan W2–W11) adds its own. */
export const routes: RouteObject[] = [
  { path: 'sign-in', element: <SignInPage /> },
  // Public (no sign-in), and not linked yet: shares are off, as on iOS (SHARE_LINKS_ENABLED=NO).
  { path: 's/:token', HydrateFallback: Loading, lazy: page(() => import('./app/share/SharedNotePage'), 'SharedNotePage') },
  {
    element: (
      <RequireAuth>
        <Shell />
      </RequireAuth>
    ),
    HydrateFallback: Loading,
    children: [
      { index: true, element: <NotesPage /> },
      { path: 'notes/:noteId', lazy: page(() => import('./app/notes/NoteDetailPage'), 'NoteDetailPage') },
      { path: 'import', lazy: page(() => import('./app/notes/ImportPage'), 'ImportPage') },
      { path: 'record', lazy: page(() => import('./app/record/RecordPage'), 'RecordPage') },
      { path: 'search', lazy: page(() => import('./app/search/SearchPage'), 'SearchPage') },
      { path: 'settings', lazy: page(() => import('./app/settings/SettingsPage'), 'SettingsPage') },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

/** The app is served at <site>/app (vite base, vercel.json rewrite). */
export const BASENAME = '/app';
