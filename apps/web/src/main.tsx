import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { ApiProvider } from './app/ApiContext';
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <AuthProvider adapter={adapter}>
        <ApiProvider origins={origins}>
          <RouterProvider router={router} />
        </ApiProvider>
      </AuthProvider>
    </ErrorBoundary>
  </StrictMode>,
);
