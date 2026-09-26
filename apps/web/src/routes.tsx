import type { RouteObject } from 'react-router';
import { Shell } from './app/Shell';
import { RequireAuth } from './app/auth/RequireAuth';
import { SignInPage } from './app/auth/SignInPage';
import { NotFoundPage, SearchPage, SettingsPage } from './app/pages';
import { ImportPage } from './app/notes/ImportPage';
import { NoteDetailPage } from './app/notes/NoteDetailPage';
import { NotesPage } from './app/notes/NotesPage';

/** The app's routes, under the router's basename (/app). Each feature PR (plan W2–W11) adds its own. */
export const routes: RouteObject[] = [
  { path: 'sign-in', element: <SignInPage /> },
  {
    element: (
      <RequireAuth>
        <Shell />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <NotesPage /> },
      { path: 'notes/:noteId', element: <NoteDetailPage /> },
      { path: 'import', element: <ImportPage /> },
      { path: 'search', element: <SearchPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

/** The app is served at <site>/app (vite base, vercel.json rewrite). */
export const BASENAME = '/app';
