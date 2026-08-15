import { Component } from 'react';
import type { ReactNode } from 'react';
import { reportCrash } from '../lib/crashReport';

type Props = { name: string; children: ReactNode };
type State = { failed: boolean };

/**
 * Contains a render failure to one surface.
 *
 * The app had exactly one error boundary, at the root. So a throw anywhere —
 * a null field in a search result, a malformed citation — unmounted the entire
 * tree, and the recording screen is part of that tree. A bug in Search could
 * therefore end a meeting that was being recorded.
 *
 * Wrap the surfaces that render server data. Keep the recording path outside
 * any of them, so it is never the thing that gets replaced.
 */
export default class SurfaceBoundary extends Component<Props, State> {
  // The `declare` re-statements match the root boundary in main.tsx — this
  // project's React types do not surface Component's members without them.
  // setState is included because the Try again button needs it, and the root
  // boundary never called it so it never had to.
  declare props: Props;
  declare state: State;
  declare setState: Component<Props, State>['setState'];

  constructor(props: Props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error(`surface_crashed:${this.props.name}`, error, info);
    reportCrash('react.surfaceBoundary', error, {
      componentStack: (info as { componentStack?: string } | null)?.componentStack?.slice(0, 2000),
      source: this.props.name,
    });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="owll-card flex flex-col items-center text-center px-6 py-10" style={{ gap: '0.6rem' }}>
        <p style={{ color: '#E5E0DF', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.9rem' }}>
          This section couldn&rsquo;t be displayed.
        </p>
        <p style={{ color: '#8C8684', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.8rem', maxWidth: 300 }}>
          The rest of the app is still working, including anything you are recording.
        </p>
        <button
          type="button"
          onClick={() => this.setState({ failed: false })}
          style={{
            marginTop: 4, padding: '8px 18px', borderRadius: 10, border: 'none', cursor: 'pointer',
            background: 'linear-gradient(135deg, #FFFFFF 0%, #E5E5E5 100%)', color: '#030303',
            fontFamily: 'Rajdhani, sans-serif', fontWeight: 700,
          }}
        >
          Try again
        </button>
      </div>
    );
  }
}
