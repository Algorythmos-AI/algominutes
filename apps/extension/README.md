# AlgoMinutes for Chrome and Edge

The browser extension (Manifest V3), designed in `docs/decisions/0002-chrome-extension.md` and built in
RELEASE.md PR 37:

- **37a (this):** the extension signs in as the web app's user with a one-time code. It never asks for a
  password: the web app's "Connect the extension" page (`/app/connect-extension`) asks the api for a code bound
  to a verifier only the extension holds, and hands the code over. The session lives in
  `chrome.storage.session` only. Signing out of the web app signs the extension out.
- **37b:** recording the Meet tab and the microphone in an offscreen document, uploaded while recording.
- **37c:** the button on meet.google.com, and sending the notetaker.

## Build

Everything environment-specific is fixed at build time (MV3 runs no remote code):

```bash
EXT_API_ORIGIN=https://<api origin> \
EXT_WEB_ORIGINS=https://beta.algominutes.algorythmos.com \
EXT_FIREBASE_API_KEY=<the web app's VITE_FIREBASE_API_KEY> \
npm run build -w apps/extension
```

`dist/` is the extension. To try it, open `chrome://extensions` (or `edge://extensions`), turn on Developer
mode, and choose **Load unpacked** with `apps/extension/dist`. For it to sign in:

- its id (shown on that page) must be in Terraform's `extension_ids` for the environment, applied (PR 36), so
  the api allows it;
- the web app's build must list the same id in `VITE_EXTENSION_IDS`, so the connect page can find it.

## Test

```bash
npm test -w apps/extension
npm run typecheck -w apps/extension
```
