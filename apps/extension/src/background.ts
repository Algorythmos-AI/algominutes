// The extension's service worker. In 37a it only signs in (lib/link.ts) at the web app's request; capture
// comes in 37b.
import { handleExternal } from './lib/messages';

const deps = { storage: chrome.storage.session, fetch: (...a: Parameters<typeof fetch>) => fetch(...a), now: () => Date.now(), extensionId: chrome.runtime.id };

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  // A failure goes back to the page that asked, which shows it and reports it (apps/web ConnectExtensionPage).
  handleExternal(deps, message, sender).then(sendResponse, (err: unknown) =>
    sendResponse({ ok: false, error: 'failed', detail: err instanceof Error ? err.name : 'unknown' }),
  );
  return true; // answered asynchronously
});
