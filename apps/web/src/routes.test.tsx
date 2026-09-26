import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { BASENAME, routes } from './routes';

afterEach(cleanup);

const at = (path: string) => {
  const router = createMemoryRouter(routes, { basename: BASENAME, initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
};

describe('routes under /app', () => {
  it.each([
    ['/app', 'Your notes'],
    ['/app/search', 'Search'],
    ['/app/settings', 'Settings'],
    ['/app/no-such-page', 'Page not found'],
  ])('%s renders %s', async (path, heading) => {
    at(path);
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeTruthy();
  });

  it('marks the current page in the navigation', async () => {
    at('/app/search');
    const current = await screen.findByRole('link', { current: 'page' });
    expect(current.textContent).toBe('Search');
    expect(current.getAttribute('href')).toBe('/app/search');
  });

  it('links the footer to the public site, outside the app', async () => {
    at('/app');
    for (const [name, path] of [['Privacy Policy', '/privacy'], ['Terms of Service', '/terms'], ['Support', '/support']]) {
      const link = await screen.findByRole('link', { name });
      expect(new URL(link.getAttribute('href')!).pathname).toBe(path);
    }
  });
});
