import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from './AuthContext';

/** Signed-in pages only: anyone else goes to sign-in, and comes back here after. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') {
    return (
      <p role="status" className="p-8 text-center text-muted">
        Loading…
      </p>
    );
  }
  if (status === 'signed-out') {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/sign-in${next === '/' ? '' : `?next=${encodeURIComponent(next)}`}`} replace />;
  }
  return <>{children}</>;
}
