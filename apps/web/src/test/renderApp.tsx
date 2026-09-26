import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { ApiProvider } from '../app/ApiContext';
import { AuthProvider } from '../app/auth/AuthContext';
import { NoticeProvider } from '../app/Notice';
import { NotesProvider } from '../app/notes/NotesContext';
import type { AuthAdapter } from '../lib/auth/adapter';
import type { NoteDoc, NotesFeed } from '../lib/notes/notesFeed';
import { BASENAME, routes } from '../routes';

export const ORIGINS = { api: 'https://api.example.test', billing: 'https://billing.example.test' };

/** A notes feed tests push notes into. */
export function fakeFeed(initial: NoteDoc[] | null = []) {
  let listener: ((n: NoteDoc[]) => void) | null = null;
  let current = initial;
  const feed: NotesFeed = {
    subscribe: (_uid, onNotes) => {
      listener = onNotes;
      if (current) onNotes(current);
      return () => {
        listener = null;
      };
    },
  };
  return { feed, push: (n: NoteDoc[]) => { current = n; listener?.(n); } };
}

/** The whole app at `path`, on a fake adapter, notes feed and fetch. */
export function renderApp(
  path: string,
  adapter: AuthAdapter,
  fetchImpl: typeof fetch = async () => new Response('{}', { status: 200 }),
  feed: NotesFeed = fakeFeed().feed,
) {
  const router = createMemoryRouter(routes, { basename: BASENAME, initialEntries: [path] });
  render(
    <AuthProvider adapter={adapter}>
      <ApiProvider origins={ORIGINS} fetchImpl={fetchImpl}>
        <NotesProvider feed={feed}>
          <NoticeProvider>
            <RouterProvider router={router} />
          </NoticeProvider>
        </NotesProvider>
      </ApiProvider>
    </AuthProvider>,
  );
  return router;
}
