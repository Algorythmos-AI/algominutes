// The toolbar popup: connected or not, and the way to connect (the web app's page) or disconnect.
import { config } from './config';
import { readSession, signOut } from './lib/session';

const deps = { storage: chrome.storage.session, fetch: (...a: Parameters<typeof fetch>) => fetch(...a), now: () => Date.now() };

async function render(): Promise<void> {
  const signedIn = !!(await readSession(deps));
  document.getElementById('signed-in')!.hidden = !signedIn;
  document.getElementById('signed-out')!.hidden = signedIn;
}

document.getElementById('connect')!.addEventListener('click', () => {
  void chrome.tabs.create({ url: `${config.webOrigins[0]}/app/connect-extension` }).then(() => window.close());
});
document.getElementById('sign-out')!.addEventListener('click', () => {
  void signOut(deps).then(render);
});
void render();
