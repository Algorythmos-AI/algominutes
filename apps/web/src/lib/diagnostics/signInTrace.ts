// Sign-in diagnostics: every attempt leaves a compact, personal-data-free trace,
// so a failure says where the chain broke (docs/runbooks/site.md, "Sign-in
// troubleshooting"). Sign-in crosses five systems (our CSP, the Browser API key,
// Firebase Auth, the identity provider, the api); a missing setting in any of
// them can fail silently.
//
// A trace holds: an attempt id, the provider, the auth domain and page host,
// timed steps, the outcome and Firebase's error code, and the CSP violations
// seen during the attempt (directive and blocked origin only: never a full URL,
// which could carry a token). It rides in the crash report's message (the
// existing /v1/client-error, so no contract change), and the last one is kept
// in memory for /app/diagnostics (never in the browser's storage).

export type TraceOutcome = 'ok' | 'error' | 'cancelled';

export interface SignInTrace {
  id: string;
  provider: string;
  flow: 'signIn' | 'link';
  authDomain: string;
  host: string;
  startedAt: number;
  steps: Array<[string, number]>;
  outcome?: TraceOutcome;
  code?: string;
  csp: string[];
}

/** A CSP violation, reduced to what's safe and useful: the directive and the blocked origin. */
export interface Violation {
  at: number;
  directive: string;
  blocked: string;
}

const MAX_VIOLATIONS = 20;
const violations: Violation[] = [];
let last: SignInTrace | null = null;

/** The origin of a blocked URI (or its keyword: 'inline', 'eval', 'data'); never its path or query. */
export function blockedOrigin(blockedURI: string): string {
  if (!blockedURI) return 'unknown';
  if (!blockedURI.includes(':') || /^(inline|eval|wasm-eval|trusted-types-sink)$/.test(blockedURI)) return blockedURI;
  try {
    const u = new URL(blockedURI);
    return u.origin === 'null' ? u.protocol.replace(/:$/, '') : u.origin;
  } catch {
    // silent-catch-ok: an unparseable URI is reported by its scheme only.
    return blockedURI.split(':')[0];
  }
}

/** Records a violation for the traces (and returns it, for the reporter). */
export function recordViolation(directive: string, blockedURI: string, now = Date.now()): Violation {
  const v = { at: now, directive, blocked: blockedOrigin(blockedURI) };
  violations.push(v);
  if (violations.length > MAX_VIOLATIONS) violations.shift();
  return v;
}

export function violationsSince(t: number): Violation[] {
  return violations.filter((v) => v.at >= t);
}

/** Test hook. */
export function resetViolations(): void {
  violations.length = 0;
}

const randomId = () => Math.random().toString(36).slice(2, 8);

export function startTrace(provider: string, flow: SignInTrace['flow'], authDomain: string, now = Date.now, host = typeof location !== 'undefined' ? location.host : ''): {
  trace: SignInTrace;
  step: (name: string) => void;
  finish: (outcome: TraceOutcome, code?: string) => SignInTrace;
} {
  const startedAt = now();
  const trace: SignInTrace = { id: randomId(), provider, flow, authDomain, host, startedAt, steps: [['start', 0]], csp: [] };
  return {
    trace,
    step: (name) => void trace.steps.push([name, now() - startedAt]),
    finish: (outcome, code) => {
      trace.steps.push([outcome, now() - startedAt]);
      trace.outcome = outcome;
      if (code) trace.code = code;
      trace.csp = [...new Set(violationsSince(startedAt).map((v) => `${v.directive} ${v.blocked}`))];
      saveLastTrace(trace);
      return trace;
    },
  };
}

/** The trace as the crash report's message: compact JSON, capped (the api keeps 500 characters). */
export function traceMessage(t: SignInTrace, max = 480): string {
  const compact = { id: t.id, p: t.provider, f: t.flow, d: t.authDomain, h: t.host, o: t.outcome, c: t.code, s: t.steps, csp: t.csp };
  const s = JSON.stringify(compact);
  if (s.length <= max) return s;
  return JSON.stringify({ ...compact, csp: t.csp.slice(0, 2), s: t.steps.slice(-3) }).slice(0, max);
}

function saveLastTrace(t: SignInTrace): void {
  last = { ...t, steps: [...t.steps], csp: [...t.csp] };
}

/** The last attempt in this page's session (a reload forgets it). */
export function lastTrace(): SignInTrace | null {
  return last;
}

/** Test hook. */
export function forgetLastTrace(): void {
  last = null;
}
