import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportCrash } from '../lib/crashReport';

type Props = { children: ReactNode };
type State = { error: Error | null };

/** The last line of defence: a crash anywhere below shows a reload screen, and is reported. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Without this a blank screen is invisible to us.
    reportCrash('react.errorBoundary', error, { componentStack: info.componentStack?.slice(0, 2000) });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="mb-3 text-2xl font-bold text-heading">Something went wrong</h1>
          <p className="mb-6 text-muted">Reload the page to continue. If it keeps happening, contact support@algorythmos.com.</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-xl bg-accent px-6 py-3 font-semibold text-white hover:bg-accent-hover"
          >
            Reload
          </button>
        </div>
      </main>
    );
  }
}
