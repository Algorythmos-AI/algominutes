import type { RouteObject } from 'react-router';
import { Shell } from './app/Shell';
import { RequireAuth } from './app/auth/RequireAuth';
import { SignInPage } from './app/auth/SignInPage';
import { NotFoundPage, NotesPage, SearchPage, SettingsPage } from './app/pages';

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
      { path: 'search', element: <SearchPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

/** The app is served at <site>/app (vite base, vercel.json rewrite). */
export const BASENAME = '/app';
