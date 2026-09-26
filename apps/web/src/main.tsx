import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { ErrorBoundary } from './app/ErrorBoundary';
import { BASENAME, routes } from './routes';
import { installGlobalCrashHandlers } from './lib/crashReport';
import './index.css';

// Before anything renders, so a crash during the first paint is still caught.
installGlobalCrashHandlers();

const router = createBrowserRouter(routes, { basename: BASENAME });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <RouterProvider router={router} />
    </ErrorBoundary>
  </StrictMode>,
);
