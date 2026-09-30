// The toolbar popup: connect or disconnect (37a), and record the tab it was opened on (37b), after the same
// two consent ticks as the web app's call capture (docs/CONSENT.md §2.2), every time.
import { config } from './config';
import { readSession, signOut } from './lib/session';
import { readRecording, WORDS, type RecordingState } from './lib/recording';
import { meetLinkOf } from './lib/notetaker';

const deps = { storage: chrome.storage.session, fetch: (...a: Parameters<typeof fetch>) => fetch(...a), now: () => Date.now() };
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const SECTIONS = ['signed-out', 'ready', 'recording', 'saving', 'saved', 'failed'] as const;
let ticker: ReturnType<typeof setInterval> | undefined;

function show(section: (typeof SECTIONS)[number]) {
  for (const s of SECTIONS) $(s).hidden = s !== section;
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
};

async function micAllowed(): Promise<boolean> {
  const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
  return status.state === 'granted';
}

async function render(): Promise<void> {
  clearInterval(ticker);
  if (!(await readSession(deps))) return show('signed-out');
  const rec: RecordingState | null = await readRecording(deps);
  if (!rec) {
    show('ready');
    $('mic').hidden = await micAllowed();
    await offerNotetaker();
    return;
  }
  show(rec.phase);
  if (rec.phase === 'recording') {
    $('no-mic').hidden = rec.micIncluded !== false;
    const tick = () => ($('timer').textContent = clock(Date.now() - rec.startedAt));
    tick();
    ticker = setInterval(tick, 1000);
  }
  if (rec.phase === 'failed') $('failure').textContent = rec.error ?? WORDS.save_failed;
}

const ask = async (message: Record<string, unknown>) => {
  const answer = (await chrome.runtime.sendMessage({ target: 'sw', ...message })) as { ok?: boolean; error?: string } | null;
  const problem = answer && answer.ok === false ? WORDS[answer.error as keyof typeof WORDS] ?? 'Something went wrong. Try again.' : '';
  $('problem').textContent = problem;
  $('problem').hidden = !problem;
  await render();
};

// The notetaker, on a Meet tab, when /v1/config has it on for this user. One request id per popup, so a
// retry never sends a second notetaker.
const requestId = crypto.randomUUID();
let meetUrl: string | null = null;
async function offerNotetaker(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  meetUrl = meetLinkOf(tab?.url);
  if (!meetUrl) return;
  const a = (await chrome.runtime.sendMessage({ target: 'sw', type: 'notetaker-available' })) as { available?: boolean } | null;
  $('notetaker').hidden = a?.available !== true;
}
$('consent-bot').addEventListener('change', () => {
  const on = $<HTMLInputElement>('consent-bot').checked;
  $<HTMLButtonElement>('send-bot').disabled = !on;
  $('send-bot').textContent = on ? 'Send the notetaker' : 'Tick the box to send it';
});
$('send-bot').addEventListener('click', () => {
  if (!meetUrl || !$<HTMLInputElement>('consent-bot').checked) return;
  $<HTMLButtonElement>('send-bot').disabled = true;
  void (async () => {
    const r = (await chrome.runtime.sendMessage({ target: 'sw', type: 'send-notetaker', url: meetUrl, requestId })) as
      { ok: true; noteId: string; already: boolean } | { ok: false; message: string } | null;
    const status = $('bot-status');
    status.hidden = false;
    if (r?.ok) {
      status.textContent = r.already ? 'Your notetaker is already on its way to this meeting.' : 'Your notetaker is on its way. It will ask to join the meeting.';
      return;
    }
    status.textContent = r?.message ?? 'The notetaker couldn’t be sent. Try again.';
    $<HTMLButtonElement>('send-bot').disabled = false;
  })();
});

const ticked = () => $<HTMLInputElement>('consent-self').checked && $<HTMLInputElement>('consent-call').checked;
for (const id of ['consent-self', 'consent-call']) {
  $(id).addEventListener('change', () => {
    $<HTMLButtonElement>('record').disabled = !ticked();
    $('record').textContent = ticked() ? 'Record this tab' : 'Tick both boxes to start';
  });
}

$('record').addEventListener('click', () => {
  if (!ticked()) return;
  $<HTMLButtonElement>('record').disabled = true;
  void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) =>
    ask({ type: 'start', tabId: tab?.id, title: `Call, ${new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` }),
  );
});
$('stop').addEventListener('click', () => void ask({ type: 'stop' }));
$('done-saved').addEventListener('click', () => void ask({ type: 'dismiss' }));
$('done-failed').addEventListener('click', () => void ask({ type: 'dismiss' }));
$('allow-mic').addEventListener('click', (e) => {
  e.preventDefault();
  void chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
});
$('connect').addEventListener('click', () => {
  void chrome.tabs.create({ url: `${config.webOrigins[0]}/app/connect-extension` }).then(() => window.close());
});
$('sign-out').addEventListener('click', () => void signOut(deps).then(render));
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'session') void render();
});
void render();
