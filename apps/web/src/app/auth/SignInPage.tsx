import { Navigate, useSearchParams } from 'react-router';
import { SITE_URL } from '../site';
import { useAuth } from './AuthContext';

/** Where to go after signing in: an in-app path only, never another site. */
export function safeNext(raw: string | null): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\') ? raw : '/';
}

export function SignInPage() {
  const { status, error, busy, signIn, continueAsGuest } = useAuth();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  if (status === 'signed-in') return <Navigate to={next} replace />;

  const button = 'w-full rounded-xl px-5 py-3 font-semibold disabled:opacity-60';
  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-4 py-10">
      <div className="text-center">
        <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="" width={64} height={64} className="mx-auto mb-4" />
        <h1 className="text-3xl font-bold text-heading">Sign in to AlgoMinutes</h1>
        <p className="mt-2 text-muted">Every meeting, summed up.</p>
      </div>
      {error && (
        <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-body">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-3">
        <button type="button" disabled={busy || status === 'loading'} onClick={() => signIn('apple')} className={`${button} bg-white text-black`}>
          Continue with Apple
        </button>
        <button type="button" disabled={busy || status === 'loading'} onClick={() => signIn('google')} className={`${button} border border-border bg-card text-heading`}>
          Continue with Google
        </button>
        <button type="button" disabled={busy || status === 'loading'} onClick={() => continueAsGuest()} className="py-2 text-body underline">
          Try it as a guest
        </button>
      </div>
      <p className="text-center text-sm text-muted">
        By continuing, you agree to the <a href={`${SITE_URL}/terms`}>Terms of Service</a> and <a href={`${SITE_URL}/privacy`}>Privacy Policy</a>.
      </p>
    </main>
  );
}
