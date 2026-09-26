// The uploads this browser started and hasn't finished, so a tab closed mid-upload
// leaves no note stuck at 'processing': the next load fails it (the rules let the
// client mark its own 'processing' note 'error'; nothing on the server knows it
// exists before the kickoff). Only this browser's own uploads are touched, never
// a note another device is still uploading.
import { reportCrash } from '../crashReport';

const KEY = 'own_uploads';
/** Uploads running in this tab right now: never stale. */
const active = new Set<string>();

type KV = Pick<Storage, 'getItem' | 'setItem'>;

function read(store: KV): Record<string, number> {
  try {
    return JSON.parse(store.getItem(KEY) ?? '{}') as Record<string, number>;
  } catch (err) {
    reportCrash('ownUploads.read', err);
    return {};
  }
}
function write(store: KV, v: Record<string, number>) {
  try {
    store.setItem(KEY, JSON.stringify(v));
  } catch (err) {
    reportCrash('ownUploads.write', err);
  }
}

export function startedUpload(noteId: string, store: KV = localStorage, now = Date.now()) {
  active.add(noteId);
  write(store, { ...read(store), [noteId]: now });
}

export function endedUpload(noteId: string, store: KV = localStorage) {
  active.delete(noteId);
  const v = read(store);
  delete v[noteId];
  write(store, v);
}

/** This browser's unfinished uploads not running in this tab: left behind by a closed tab. */
export function abandonedUploads(store: KV = localStorage): string[] {
  return Object.keys(read(store)).filter((id) => !active.has(id));
}
