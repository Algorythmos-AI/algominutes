import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { ApiProvider } from '../app/ApiContext';
import { AuthProvider } from '../app/auth/AuthContext';
import type { AuthAdapter } from '../lib/auth/adapter';
import { BASENAME, routes } from '../routes';

export const ORIGINS = { api: 'https://api.example.test', billing: 'https://billing.example.test' };

/** The whole app at `path`, on a fake adapter and a fake fetch. */
export function renderApp(path: string, adapter: AuthAdapter, fetchImpl: typeof fetch = async () => new Response('{}', { status: 200 })) {
  const router = createMemoryRouter(routes, { basename: BASENAME, initialEntries: [path] });
  render(
    <AuthProvider adapter={adapter}>
      <ApiProvider origins={ORIGINS} fetchImpl={fetchImpl}>
        <RouterProvider router={router} />
      </ApiProvider>
    </AuthProvider>,
  );
  return router;
}
