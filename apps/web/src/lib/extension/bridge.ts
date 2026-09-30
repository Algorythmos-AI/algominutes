// Talking to the AlgoMinutes browser extension from the web app (ADR 0002 §3). Chrome and Edge give a page
// `chrome.runtime.sendMessage(extensionId, …)` when an installed extension lists the page's origin in its
// externally_connectable; the extension checks the sender's origin again on every message.

/** The extension's store ids (Chrome's and Edge's differ), from VITE_EXTENSION_IDS. None: no extension yet. */
export function extensionIdsFromEnv(env: Record<string, string | undefined> = import.meta.env): string[] {
  return String(env.VITE_EXTENSION_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[a-p]{32}$/.test(s));
}

interface Runtime {
  sendMessage(extensionId: string, message: unknown, callback: (response: unknown) => void): void;
  lastError?: { message?: string };
}

function runtime(): Runtime | null {
  const r = (globalThis as { chrome?: { runtime?: Runtime } }).chrome?.runtime;
  return r && typeof r.sendMessage === 'function' ? r : null;
}

/** Whether this browser can talk to an extension at all (Chrome or Edge, with one installed for this site). */
export const canMessageExtensions = () => runtime() !== null;

/** Send one message; null when there's no such extension, it didn't answer in time, or this browser can't. */
export function sendToExtension(extensionId: string, message: unknown, timeoutMs = 3000): Promise<Record<string, unknown> | null> {
  const r = runtime();
  if (!r) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    r.sendMessage(extensionId, message, (response) => {
      clearTimeout(timer);
      // Reading lastError is what tells Chrome the page expected it (an extension that isn't installed).
      const missing = !!r.lastError;
      resolve(!missing && typeof response === 'object' && response !== null ? (response as Record<string, unknown>) : null);
    });
  });
}

/** The first installed extension of ours to answer hello, with the hash of the verifier it made. */
export async function findExtension(ids: string[]): Promise<{ id: string; verifierHash: string; version: string } | null> {
  for (const id of ids) {
    const a = await sendToExtension(id, { type: 'hello' });
    if (a?.ok === true && typeof a.verifierHash === 'string') return { id, verifierHash: a.verifierHash, version: String(a.version ?? '') };
  }
  return null;
}

/** Signing out of the web app signs the extension out too (ADR 0002 §3, step 5). */
export async function signOutExtensions(ids: string[] = extensionIdsFromEnv()): Promise<void> {
  await Promise.all(ids.map((id) => sendToExtension(id, { type: 'sign-out' })));
}
