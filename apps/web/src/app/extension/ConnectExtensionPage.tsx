// "Connect the extension" (RELEASE.md PR 37a, ADR 0002 §3). The browser extension's popup opens this page;
// the signed-in web app asks the api for a one-time code bound to the extension's verifier, and hands the
// code to the extension, which signs in with it. The extension never sees a password.
import { useState } from 'react';
import { useApi } from '../ApiContext';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../../lib/api/errors';
import { reportCrash } from '../../lib/crashReport';
import { canMessageExtensions, extensionIdsFromEnv, findExtension, sendToExtension } from '../../lib/extension/bridge';

type State =
  | { kind: 'ready' }
  | { kind: 'working' }
  | { kind: 'connected' }
  | { kind: 'problem'; message: string };

const WORDS: Record<string, string> = {
  unavailable: 'The AlgoMinutes extension isn’t available yet.',
  unsupported: 'The AlgoMinutes extension works in Chrome and Microsoft Edge. Open this page there.',
  'not-installed': 'Install the AlgoMinutes extension first, then come back to this page.',
  please_update: 'Your AlgoMinutes extension is out of date. Update it, then try again.',
  refused: 'That didn’t work. Open the extension and choose Connect again.',
  expired: 'That took too long. Open the extension and choose Connect again.',
  failed: 'Something went wrong. Try again.',
};

export function ConnectExtensionPage() {
  const { api } = useApi();
  const { user } = useAuth();
  const [state, setState] = useState<State>({ kind: 'ready' });

  const connect = async () => {
    setState({ kind: 'working' });
    try {
      const ids = extensionIdsFromEnv();
      if (!ids.length) return setState({ kind: 'problem', message: WORDS.unavailable! });
      if (!canMessageExtensions()) return setState({ kind: 'problem', message: WORDS.unsupported! });
      const found = await findExtension(ids);
      if (!found) return setState({ kind: 'problem', message: WORDS['not-installed']! });
      const { code } = await api.extensionLink({ extensionId: found.id, verifierHash: found.verifierHash });
      const answer = await sendToExtension(found.id, { type: 'link', code });
      if (answer?.ok === true) return setState({ kind: 'connected' });
      const why = typeof answer?.error === 'string' ? answer.error : 'failed';
      if (why === 'failed') reportCrash('extension.link', new Error(`extension link failed: ${String(answer?.detail ?? 'no answer')}`));
      setState({ kind: 'problem', message: WORDS[why] ?? WORDS.failed! });
    } catch (err) {
      if (!(err instanceof ApiError)) reportCrash('extension.link', err);
      setState({ kind: 'problem', message: err instanceof ApiError ? err.message : WORDS.failed! });
    }
  };

  return (
    <section className="mx-auto max-w-lg p-6">
      <h1 className="text-xl font-semibold">Connect the extension</h1>
      {state.kind === 'connected' ? (
        <p role="status" className="mt-3">Connected. The extension is signed in{user?.email ? ` as ${user.email}` : ''}. You can close this tab.</p>
      ) : (
        <>
          <p className="mt-3">
            This signs the AlgoMinutes extension in this browser into your account{user?.email ? ` (${user.email})` : ''}. You won’t
            enter a password in the extension.
          </p>
          <button type="button" className="mt-4 rounded-md bg-[var(--color-brand,#3715e0)] px-4 py-2 text-white disabled:opacity-60"
            onClick={() => void connect()} disabled={state.kind === 'working'}>
            {state.kind === 'working' ? 'Connecting…' : 'Connect the extension'}
          </button>
          {state.kind === 'problem' && <p role="alert" className="mt-3">{state.message}</p>}
        </>
      )}
    </section>
  );
}
