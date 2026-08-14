import { Component, StrictMode } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { installGlobalCrashHandlers, reportCrash } from './lib/crashReport';
import './index.css';

// Before anything renders, so a crash during the first paint is still caught.
installGlobalCrashHandlers();

type EBProps = { children: ReactNode };
type EBState = { error: Error | null };

class ErrorBoundary extends Component<EBProps, EBState> {
  declare props: EBProps;
  declare state: EBState;
  constructor(props: EBProps) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error): EBState { return { error }; }
  componentDidCatch(error: Error, info: unknown) {
    console.error('App error:', error, info);
    // Without this a blank screen is invisible to us — the doctor sees the
    // fallback and we never learn it happened.
    reportCrash('react.errorBoundary', error, {
      componentStack: (info as { componentStack?: string } | null)?.componentStack?.slice(0, 2000),
    });
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: '100vh', background: '#030303', color: '#E5E0DF', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: 'Titillium Web, sans-serif' }}>
          <div style={{ maxWidth: 420, textAlign: 'center' }}>
            <h1 style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 800, fontSize: '1.5rem', color: '#FFFFFF', marginBottom: 12 }}>Something went wrong</h1>
            <p style={{ color: '#8C8684', fontSize: '0.9rem', marginBottom: 24 }}>Refresh the page to continue. If this keeps happening, contact support.</p>
            <button
              onClick={() => window.location.reload()}
              // Dark text on the light button. This read `color: '#fff'` on a
              // white gradient, so the only affordance on the crash screen was
              // invisible — the one screen where the user has nothing else to go on.
              style={{ background: 'linear-gradient(135deg, #FFFFFF 0%, #E5E5E5 100%)', color: '#030303', border: 'none', padding: '12px 24px', borderRadius: 12, fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, cursor: 'pointer' }}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
