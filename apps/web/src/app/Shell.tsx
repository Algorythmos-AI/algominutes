import { useEffect } from 'react';
import { NavLink, Outlet } from 'react-router';
import { useApi } from './ApiContext';
import { AccountControls } from './auth/AccountControls';
import { useAuth } from './auth/AuthContext';
import { recordTermsAcceptanceIfNeeded } from './auth/terms';
import { SITE_URL } from './site';

const nav = [
  { to: '/', label: 'Notes', end: true },
  { to: '/search', label: 'Search', end: false },
  { to: '/settings', label: 'Settings', end: false },
];

/** Every signed-in page: the header, the main navigation and the footer links to the site. */
export function Shell() {
  const { api, updateRequired } = useApi();
  const { user } = useAuth();
  const uid = user?.uid;
  const permanent = user ? !user.isAnonymous : false;
  useEffect(() => {
    if (uid && permanent) void recordTermsAcceptanceIfNeeded(api, { uid, isAnonymous: false, email: null, displayName: null });
  }, [api, uid, permanent]);
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded focus:bg-card focus:px-3 focus:py-2">
        Skip to content
      </a>
      <header className="border-b border-border">
        <div className="mx-auto flex min-h-16 max-w-5xl flex-wrap items-center justify-between gap-4 px-4">
          <a href={SITE_URL} className="flex items-center gap-2 text-lg font-bold text-heading no-underline">
            <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="" width={32} height={32} />
            AlgoMinutes
          </a>
          <nav aria-label="Main">
            <ul className="flex gap-1">
              {nav.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      `inline-block rounded-lg px-3 py-2 no-underline ${isActive ? 'bg-card text-heading' : 'text-body hover:text-heading'}`
                    }
                  >
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <AccountControls />
        </div>
      </header>
      {updateRequired && (
        <div role="alert" className="bg-warning/15 px-4 py-3 text-center text-heading">
          A newer version of AlgoMinutes is available. <button type="button" className="font-semibold underline" onClick={() => window.location.reload()}>Reload</button>
        </div>
      )}
      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <Outlet />
      </main>
      <footer className="border-t border-border py-6 text-sm text-muted">
        <div className="mx-auto flex max-w-5xl flex-wrap gap-x-5 gap-y-1 px-4">
          <a href={`${SITE_URL}/support`}>Support</a>
          <a href={`${SITE_URL}/privacy`}>Privacy Policy</a>
          <a href={`${SITE_URL}/terms`}>Terms of Service</a>
        </div>
      </footer>
    </div>
  );
}
