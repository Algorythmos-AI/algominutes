# AlgoMinutes for Chrome and Edge

The browser extension (Manifest V3), designed in `docs/decisions/0002-chrome-extension.md` and built in
RELEASE.md PR 37:

- **37a (this):** the extension signs in as the web app's user with a one-time code. It never asks for a
  password: the web app's "Connect the extension" page (`/app/connect-extension`) asks the api for a code bound
  to a verifier only the extension holds, and hands the code over. The session lives in
  `chrome.storage.session` only. Signing out of the web app signs the extension out.
- **37b:** recording a meeting tab and the microphone in an offscreen document, uploaded while recording.
  The popup asks for the web app's two consent ticks every time, then records the tab it was opened on. At
  Stop (or when the tab closes) the upload finishes, and the note is made (`POST /v1/notes`) and processed
  (`POST /v1/process`), as a web recording is. The microphone is asked for once, on an extension page
  (`permission.html`); without it, only the other people are recorded, and the popup says so.
- **37c:** on a Google Meet tab, the popup also offers **Send the notetaker** (the web app's bot), after the
  same affirmation, when the api has the notetaker on for this user. Nothing is drawn into Meet's page.
- **37d:** a recording interrupted by the browser closing is saved from what was uploaded: its upload
  details are kept in `chrome.storage.local` (never the sign-in), and the next time the extension starts or
  its popup opens, what Cloud Storage holds is finalised and saved as the note. If the restart signed the
  extension out, it's saved once it's connected again.
- **37e:** the part Cloud Storage hasn't acknowledged yet (up to about 40 seconds: it takes only whole 256 KiB
  pieces until the last one) is copied into the extension's IndexedDB as it changes, and recovery sends it as
  the last chunk. Only the last few seconds still inside the recorder can be lost. The copy is deleted when the
  recording is saved or fails.

## Build

Everything environment-specific is fixed at build time (MV3 runs no remote code):

```bash
EXT_API_ORIGIN=https://<api origin> \
EXT_WEB_ORIGINS=https://beta.algominutes.algorythmos.com \
EXT_FIREBASE_API_KEY=<the web app's VITE_FIREBASE_API_KEY> \
npm run build -w apps/extension
```

A build trusts only https web origins; add `EXT_DEV=1` to trust a local web app (`http://localhost:…`), and
never ship that build: any page on a trusted origin can hand the extension a sign-in code.

`dist/` is the extension. To try it, open `chrome://extensions` (or `edge://extensions`), turn on Developer
mode, and choose **Load unpacked** with `apps/extension/dist`. For it to sign in:

- its id (shown on that page) must be in Terraform's `extension_ids` for the environment, applied (PR 36), so
  the api allows it;
- the web app's build must list the same id in `VITE_EXTENSION_IDS`, so the connect page can find it.

## Try a recording (the checks ADR 0002 leaves to a real browser)

1. Load it unpacked and connect it (above).
2. Open the popup, choose **Allow it** under the microphone line, and allow it in the tab that opens.
3. Join a Google Meet. From the meeting's tab, open the popup, tick both boxes and choose **Record this
   tab**. The toolbar shows REC, and you still hear the call.
4. Talk for a few minutes, then **Stop and save** (or close the Meet tab). The note appears in AlgoMinutes
   and is processed with both sides of the call.

This proves what unit tests can't: that Chrome grants the tab's stream from the popup, that the offscreen
document can use the microphone once it's allowed, and that Cloud Storage accepts the upload from the
extension.

## Test

```bash
npm test -w apps/extension
npm run typecheck -w apps/extension
```
