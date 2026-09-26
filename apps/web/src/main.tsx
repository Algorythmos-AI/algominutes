import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { ApiProvider } from './app/ApiContext';
import { NoticeProvider } from './app/Notice';
import { NotesProvider } from './app/notes/NotesContext';
import { firestore } from './firebase';
import { createNoteDoc, ensureWorkspace, markNoteFailed } from './lib/notes/noteCache';
import { firestoreNotesFeed } from './lib/notes/notesFeed';
import { AuthProvider } from './app/auth/AuthContext';
import { ErrorBoundary } from './app/ErrorBoundary';
import { originsFromEnv } from './lib/api/config';
import { firebaseAdapter } from './lib/auth/firebaseAdapter';
import { BASENAME, routes } from './routes';
import { installGlobalCrashHandlers } from './lib/crashReport';
import './index.css';

// Before anything renders, so a crash during the first paint is still caught.
installGlobalCrashHandlers();

const router = createBrowserRouter(routes, { basename: BASENAME });
const adapter = firebaseAdapter();
const origins = originsFromEnv();
const feed = firestoreNotesFeed(firestore);
const bootstrap = async (uid: string) => ensureWorkspace(await firestore(), uid);
const writer = {
  createNoteDoc: async (n: Parameters<typeof createNoteDoc>[1]) => createNoteDoc(await firestore(), n),
  markNoteFailed: async (uid: string, noteId: string, message: string) => markNoteFailed(await firestore(), uid, noteId, message),
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <AuthProvider adapter={adapter}>
        <ApiProvider origins={origins}>
          <NotesProvider feed={feed} bootstrap={bootstrap} writer={writer}>
            <NoticeProvider>
              <RouterProvider router={router} />
            </NoticeProvider>
          </NotesProvider>
        </ApiProvider>
      </AuthProvider>
    </ErrorBoundary>
  </StrictMode>,
);
