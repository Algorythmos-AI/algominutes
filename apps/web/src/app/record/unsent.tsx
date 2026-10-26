import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { reportCrash } from '../../lib/crashReport';
import { leftOver } from '../../lib/recorder/recorder';
import type { RecordingMeta } from '../../lib/recorder/store';
import { useAuth } from '../auth/AuthContext';
import { recorderEnv } from './env';
import type { RecorderEnv } from './RecordPage';

type Kept = Pick<RecorderEnv, 'store' | 'locks'>;

/** This browser's recorder store, where it has one (a browser without IndexedDB never keeps a recording). */
export const keptRecordings = (): Kept | null => (typeof indexedDB === 'undefined' ? null : recorderEnv());

/** The user's recordings left on this browser (a closed tab, a failed upload), not ones a tab is still making. */
export async function unsentRecordings(env: Kept, uid: string): Promise<RecordingMeta[]> {
  return leftOver(await env.store.list(uid), env.locks);
}

/**
 * On the notes list, so a recording that didn't upload is seen where the notes are, not only on the record
 * page (RELEASE.md PR 12a). Upload it from there.
 */
export function UnsentRecordingsNotice({ env = keptRecordings() }: { env?: Kept | null }) {
  const { user } = useAuth();
  const uid = user?.uid;
  const [left, setLeft] = useState<RecordingMeta[]>([]);
  useEffect(() => {
    if (!uid || !env) return;
    let cancelled = false;
    unsentRecordings(env, uid).then(
      (l) => !cancelled && setLeft(l),
      (err: unknown) => reportCrash('notes.unsentRecordings', err),
    );
    return () => {
      cancelled = true;
    };
  }, [env, uid]);
  if (left.length === 0) return null;
  const one = left.length === 1;
  return (
    <div className="mb-6 rounded-2xl border border-warning/50 bg-warning/10 p-4">
      <p className="font-semibold text-heading">{one ? 'A recording wasn’t uploaded' : `${left.length} recordings weren’t uploaded`}</p>
      <p className="mt-1 text-body">
        {one ? 'It’s saved in this browser. ' : 'They’re saved in this browser. '}
        <Link to="/record">{one ? 'Upload it' : 'Upload them'}</Link>
      </p>
    </div>
  );
}
