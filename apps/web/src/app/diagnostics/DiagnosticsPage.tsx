import { useEffect, useState } from 'react';
import pkg from '../../../package.json';
import { firebaseConfigFromEnv } from '../../firebase';
import { originsFromEnv } from '../../lib/api/config';
import { apiCheck, cspChecks, handlerCheck, maskKey, popupCheck, projectChecks, type Check, type DiagConfig } from '../../lib/diagnostics/checks';
import { lastTrace } from '../../lib/diagnostics/signInTrace';

export interface DiagEnv {
  config: () => DiagConfig;
  cspHeader: () => Promise<string>;
  fetchImpl?: typeof fetch;
  open?: typeof window.open;
  /** Loads a URL in a hidden frame (checks.ts frameProbe). */
  probe?: (url: string) => Promise<boolean>;
}

function browserEnv(): DiagEnv {
  return {
    config: () => {
      const fb = firebaseConfigFromEnv();
      return { host: location.host, authDomain: fb.authDomain, projectId: fb.projectId, apiKey: fb.apiKey, apiOrigin: originsFromEnv().api };
    },
    // This page's own response headers: the CSP every /app page is served with.
    cspHeader: async () => (await fetch(location.pathname, { cache: 'no-store', credentials: 'include' })).headers.get('content-security-policy') ?? '',
  };
}

const ICON: Record<Check['status'], string> = { ok: '✓', fail: '✕', warn: '!' };
const TONE: Record<Check['status'], string> = { ok: 'text-success', fail: 'text-danger', warn: 'text-warning' };

/**
 * A self-test of sign-in from the user's own browser (docs/runbooks/site.md, "Sign-in troubleshooting"): the
 * page's CSP, the API key and Firebase's authorized domains, the auth handler, the api's CORS, popups, and the last
 * attempt's trace. Public, so it works when sign-in doesn't; nothing secret is shown. "Copy report" gives support
 * everything in one paste.
 */
/** The build's sign-in config, or why there isn't one (read once: it's fixed at build time). */
function readConfig(env: DiagEnv): { config: DiagConfig | null; error: string | null } {
  try {
    return { config: env.config(), error: null };
  } catch (err) {
    return { config: null, error: (err as Error).message };
  }
}

async function runChecks(env: DiagEnv, c: DiagConfig): Promise<Check[]> {
  const origin = `${location.protocol}//${c.host}`;
  const [csp, project, handler, api] = await Promise.all([
    env.cspHeader().then((h) => cspChecks(h, c)),
    projectChecks(c, env.fetchImpl),
    handlerCheck(c, env.fetchImpl, env.probe),
    apiCheck(c, origin, env.fetchImpl),
  ]);
  return [...csp, ...project, handler, api];
}

export function DiagnosticsPage({ env = browserEnv() }: { env?: DiagEnv }) {
  const [{ config, error: configError }] = useState(() => readConfig(env));
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [round, setRound] = useState(0);
  const [copied, setCopied] = useState(false);
  const trace = lastTrace();

  useEffect(() => {
    if (!config) return;
    let live = true;
    runChecks(env, config).then(
      (list) => live && setChecks(list),
      (err: unknown) => live && setChecks([{ id: 'run', label: 'The checks ran', status: 'fail', detail: (err as Error).message }]),
    );
    return () => {
      live = false;
    };
  }, [env, config, round]);

  const again = () => {
    setChecks(null);
    setRound((r) => r + 1);
  };

  const report = () =>
    JSON.stringify(
      {
        app: `web/${pkg.version}`,
        at: new Date().toISOString(),
        host: config?.host,
        authDomain: config?.authDomain,
        projectId: config?.projectId,
        apiKey: config ? maskKey(config.apiKey) : undefined,
        apiOrigin: config?.apiOrigin,
        userAgent: navigator.userAgent,
        checks: checks?.map(({ id, status, detail }) => ({ id, status, detail })),
        lastSignIn: trace,
      },
      null,
      2,
    );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report());
      setCopied(true);
    } catch {
      // silent-catch-ok: clipboard refused; the report is also shown on the page to copy by hand.
      setCopied(false);
    }
  };

  const failing = checks?.filter((c) => c.status !== 'ok').length ?? 0;
  return (
    <main id="main" className="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-10">
      <h1 className="text-3xl font-bold text-heading">Sign-in check</h1>
      <p className="text-body">
        Checks each part of signing in, from this browser. If sign-in isn’t working, copy the report and send it to{' '}
        <a href="mailto:support@algorythmos.com">support@algorythmos.com</a>. It contains no password or personal details.
      </p>
      {configError && <p role="alert" className="text-danger">This build isn’t configured for sign-in: {configError}</p>}
      {config && (
        <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 rounded-2xl border border-border bg-card p-4 text-sm">
          <dt className="text-muted">App</dt><dd>web/{pkg.version}</dd>
          <dt className="text-muted">This site</dt><dd>{config.host}</dd>
          <dt className="text-muted">Signs in at</dt><dd>{config.authDomain}</dd>
          <dt className="text-muted">Firebase project</dt><dd>{config.projectId}</dd>
          <dt className="text-muted">api</dt><dd className="break-all">{config.apiOrigin}</dd>
        </dl>
      )}
      <section aria-labelledby="checks-title" className="flex flex-col gap-2">
        <h2 id="checks-title" className="text-xl font-bold text-heading">
          {checks ? (failing ? `${failing} to fix` : 'Everything checks out') : 'Checking…'}
        </h2>
        <ul className="flex flex-col gap-2">
          {checks?.map((c) => (
            <li key={c.id} className="rounded-xl border border-border bg-card p-3">
              <p className="font-semibold text-heading"><span aria-hidden className={TONE[c.status]}>{ICON[c.status]}</span> {c.label}</p>
              <p className="text-sm text-body">{c.detail}</p>
              {c.fix && <p className="mt-1 text-sm text-heading">Fix: {c.fix}</p>}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="rounded-xl border border-border px-4 py-2" onClick={again}>Run again</button>
          <button type="button" className="rounded-xl border border-border px-4 py-2" onClick={() => setChecks((list) => [...(list ?? []).filter((c) => c.id !== 'popup'), popupCheck(env.open)])}>
            Test the sign-in window
          </button>
          <button type="button" className="rounded-xl bg-accent px-4 py-2 font-semibold text-white" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy report'}
          </button>
        </div>
      </section>
      <section aria-labelledby="trace-title">
        <h2 id="trace-title" className="text-xl font-bold text-heading">Last sign-in attempt since this page loaded</h2>
        {trace ? (
          <p className="text-body">
            {trace.provider}, {trace.outcome ?? 'unfinished'}
            {trace.code ? ` (${trace.code})` : ''} after {Math.round((trace.steps.at(-1)?.[1] ?? 0) / 100) / 10}s at {trace.authDomain || 'this site'}
            {trace.csp.length ? `; blocked by the page’s policy: ${trace.csp.join(', ')}` : ''}.
          </p>
        ) : (
          <p className="text-muted">None yet. Try signing in, then come back to this page.</p>
        )}
      </section>
      <details>
        <summary className="cursor-pointer text-muted">The report</summary>
        <pre className="mt-2 overflow-x-auto rounded-xl bg-bg p-3 text-xs">{report()}</pre>
      </details>
    </main>
  );
}
