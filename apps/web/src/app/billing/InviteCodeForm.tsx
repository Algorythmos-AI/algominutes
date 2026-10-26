import { useId, useState, type FormEvent } from 'react';
import type { RedeemInviteResponse } from '@algominutes/contracts';
import { inviteErrorMessage, inviteSuccessLine } from '../../lib/billing/invite';
import { useApi } from '../ApiContext';

/**
 * Enter the invite code from a beta invitation (docs/plans/RELEASE.md PR 9).
 * Used in Settings' plan card, and on the record page when no minutes are left.
 */
export function InviteCodeForm({ onRedeemed, autoFocus = false }: { onRedeemed?: (r: RedeemInviteResponse) => void; autoFocus?: boolean }) {
  const { api } = useApi();
  const id = useId();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const entered = code.trim();
    if (!entered || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.redeemInvite({ code: entered });
      setDone(inviteSuccessLine(r));
      setCode('');
      onRedeemed?.(r);
    } catch (err) {
      setError(inviteErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2" aria-describedby={`${id}-hint`}>
      <label htmlFor={`${id}-code`} className="font-medium text-heading">Invite code</label>
      <p id={`${id}-hint`} className="text-sm text-muted">
        Your invitation has a code like BETA-XXXXX-XXXXX-XXXXX. It adds recording minutes to this account.
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          id={`${id}-code`}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="BETA-XXXXX-XXXXX-XXXXX"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          autoFocus={autoFocus}
          className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 font-mono text-heading"
        />
        <button type="submit" disabled={busy || !code.trim()} className="rounded-xl bg-accent px-4 py-2 font-semibold text-white disabled:opacity-60">
          {busy ? 'Adding…' : 'Add minutes'}
        </button>
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {done && <p role="status" className="text-sm text-body">{done}</p>}
    </form>
  );
}
