// The part of a recording Cloud Storage hasn't acknowledged yet (RELEASE.md PR 37e, ADR 0002 §2): until the
// last chunk, it takes only whole 256 KiB pieces, so up to about 40 seconds of audio are only in the recorder.
// The offscreen recorder keeps a copy here, in IndexedDB, as it changes; if the browser closes, recovery
// (lib/recovery.ts) sends it as the last chunk. The extension's pages and its service worker share one origin,
// so both see the same database.

export interface Tail {
  /** The offset in the recording of the first byte of `data`: what Cloud Storage held when it was written. */
  start: number;
  data: Blob;
}

export interface TailStore {
  put(uploadId: string, tail: Tail): Promise<void>;
  get(uploadId: string): Promise<Tail | null>;
  delete(uploadId: string): Promise<void>;
}

/** For tests, and anywhere IndexedDB isn't there. */
export function memoryTailStore(): TailStore & { data: Map<string, Tail> } {
  const data = new Map<string, Tail>();
  return {
    data,
    async put(id, tail) { data.set(id, tail); },
    async get(id) { return data.get(id) ?? null; },
    async delete(id) { data.delete(id); },
  };
}

const DB = 'algominutes';
const STORE = 'tails';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = work(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(req.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  }));
}

export function idbTailStore(): TailStore {
  return {
    put: (id, tail) => run('readwrite', (s) => s.put(tail, id)).then(() => undefined),
    get: (id) => run('readonly', (s) => s.get(id) as IDBRequest<Tail | undefined>).then((t) => t ?? null),
    delete: (id) => run('readwrite', (s) => s.delete(id)).then(() => undefined),
  };
}
