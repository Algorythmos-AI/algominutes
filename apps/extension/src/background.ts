// The extension's service worker: it signs in at the web app's request (lib/link.ts, 37a) and runs
// recordings for the popup (lib/recording.ts, 37b).
import { handleExternal } from './lib/messages';
import { dismissRecording, startRecording, stopRecording, type Deps } from './lib/recording';

const OFFSCREEN = 'offscreen.html';

const deps: Deps = {
  storage: chrome.storage.session,
  fetch: (...a: Parameters<typeof fetch>) => fetch(...a),
  now: () => Date.now(),
  streamIdFor: (tabId) => chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }),
  async toOffscreen(message) {
    const open = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!open.length) {
      await chrome.offscreen.createDocument({ url: OFFSCREEN, reasons: ['USER_MEDIA'], justification: 'Recording the meeting tab and the microphone' });
    }
    return (await chrome.runtime.sendMessage({ target: 'offscreen', ...message })) as Awaited<ReturnType<Deps['toOffscreen']>>;
  },
  async closeOffscreen() {
    if ((await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length) await chrome.offscreen.closeDocument();
  },
  async setBadge(text) {
    await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
    await chrome.action.setBadgeText({ text });
  },
  newNoteId: () => crypto.randomUUID(),
};

// One at a time: the popup's Stop and the tab closing can arrive together, and a recording is saved once.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  // silent-catch-ok: the failure goes to whoever asked (next, returned); the queue itself carries on for the next message
  queue = next.catch(() => undefined);
  return next;
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  // A failure goes back to the page that asked, which shows it and reports it (apps/web ConnectExtensionPage).
  handleExternal({ ...deps, extensionId: chrome.runtime.id }, message, sender).then(sendResponse, (err: unknown) =>
    sendResponse({ ok: false, error: 'failed', detail: err instanceof Error ? err.name : 'unknown' }),
  );
  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const m = message as { target?: string; type?: string; tabId?: number; title?: string };
  if (sender.id !== chrome.runtime.id || m?.target !== 'sw') return false;
  const work =
    m.type === 'start' && typeof m.tabId === 'number' ? serial(() => startRecording(deps, { tabId: m.tabId!, title: String(m.title ?? 'Meeting') }))
    : m.type === 'stop' || m.type === 'tab-ended' || m.type === 'upload-failed' ? serial(() => stopRecording(deps))
    : m.type === 'dismiss' ? serial(() => dismissRecording(deps))
    : Promise.resolve({ ok: false, error: 'invalid' });
  // The popup shows the outcome from chrome.storage.session; a failure here is the popup's to show too.
  work.then(sendResponse, (err: unknown) => sendResponse({ ok: false, error: 'failed', detail: err instanceof Error ? err.name : 'unknown' }));
  return true;
});
