# The browser extension beta (RELEASE.md PRs 37 and 38)

The AlgoMinutes extension for Chrome and Edge records a meeting's tab and the microphone, or sends the notetaker,
from the toolbar (design: `docs/decisions/0002-chrome-extension.md`; code: `apps/extension`). In the beta it
talks to staging, like the iPhone and web betas, and testers install it from an unlisted Chrome Web Store link or
a hidden Edge Add-ons link. The first part is for testers; the rest is for whoever runs the beta.

## For testers

### Install and connect

1. On a computer, open the install link from your invitation in **Chrome** or **Microsoft Edge**, and choose
   **Add to Chrome** (or **Get** in Edge).
2. Pin it: the puzzle-piece icon in the toolbar, then the pin next to **AlgoMinutes**.
3. Click the AlgoMinutes icon, then **Connect to AlgoMinutes**. The beta web app opens; sign in there if you
   haven't (the same account as your iPhone or web beta), then **Connect the extension**. You never type a
   password into the extension.
4. Click the icon again, choose **Allow it** under the microphone line, and allow the microphone in the tab that
   opens. Without it, only the other people on the call are recorded.

### Record a meeting

1. Join the meeting in its own tab (Google Meet, or any call in a browser tab).
2. **From that tab**, click the AlgoMinutes icon. Tick both boxes (your permission, and everyone on the call
   agreeing to be recorded), then **Record this tab**. The icon shows **REC**, and you still hear the call.
3. **Stop and save** in the popup, or just close the meeting's tab. The recording has been uploading all along,
   so it's saved within seconds; the note is ready a few minutes later in the app.

Chrome only lets the extension record the tab you clicked it from, so always start from the meeting's tab.

### Send the notetaker (if your invitation includes it)

On a Google Meet tab, the popup also offers **Send the notetaker**. Tick the box and send it: it asks to join as
your notetaker, everyone sees it, and the note appears in the app with the speakers' names.

### If something goes wrong

| What you see | What to do |
|---|---|
| "Install the AlgoMinutes extension first" on the connect page | Install it from your link, then reload the connect page. |
| "Chrome didn't let the extension record this tab" | Open the popup from the meeting's own tab, not another one. |
| "Your microphone isn't allowed yet" | **Allow it** in the popup, and allow the microphone in the tab that opens. |
| "The browser closed while recording" | The recording is saved, all but its last few seconds. |
| "A recording was interrupted when the browser closed. Connect again…" | Connect again: the recording is then saved. |
| "This version of the extension is out of date" | Chrome and Edge update extensions on their own; restart the browser, or remove and reinstall it from your link. |
| "You're out of recording minutes" | Add minutes with an invite code in the app's Settings; the recording is kept. |

Tell us in the web app's **Settings → Help & Support**, or reply to your invitation.

## Running it

### Build for the beta (staging)

```bash
EXT_API_ORIGIN=https://api-627101926311.australia-southeast1.run.app \
EXT_WEB_ORIGINS=https://beta.algominutes.algorythmos.com \
EXT_FIREBASE_API_KEY=<staging's VITE_FIREBASE_API_KEY, from the beta Vercel project> \
npm run build -w apps/extension
cd apps/extension/dist && zip -r ../algominutes-extension-$(node -p "require('../package.json').version").zip .
```

- The build refuses an http web origin unless `EXT_DEV=1`: a store build must trust only the beta's https origin,
  because any page on a trusted origin can hand the extension a sign-in code.
- `version` in `apps/extension/package.json` is the manifest's version. Each store upload needs a higher one, and
  it must never be below `MIN_SUPPORTED_CLIENT.extension` (`packages/contracts/src/version.ts`).

### The first upload: getting the ids (once per store)

The extension's id is fixed by each store at the first upload, and differs between Chrome and Edge.

1. **Chrome Web Store** (developer account, one-time fee): **New item**, upload the zip, and set
   **Visibility: Unlisted**. The item's id is the extension id.
2. **Edge Add-ons** (Partner Center): **Create new extension**, upload the same zip, and set **Visibility: Hidden**.
3. Put both ids in `extension_ids` in `infra/terraform/envs/staging/main.tf`, then plan and apply (**Apply C**,
   PR 36). Until then the api refuses the extension (its sign-in answers 503).
4. Set `VITE_EXTENSION_IDS=<chrome id>,<edge id>` in the beta Vercel project and redeploy it, so the connect page
   finds the extension.
5. For the notetaker button: plan with `TF_VAR_notetaker_surfaces=bot,extension` and apply. It shows only to
   allowlisted notetaker testers (`grant-notetaker`).

### Store listing text

- **Name:** AlgoMinutes
- **Summary** (at most 132 characters): Record your meetings into AlgoMinutes: summaries, action items and a
  searchable transcript.
- **Description:**

  > AlgoMinutes turns your meetings into notes: a summary, the decisions and action items, chapters, and a
  > transcript you can search and ask questions of.
  >
  > With the extension, record a meeting from its browser tab (Google Meet, or any call in a tab) with your
  > microphone, in one click from the toolbar. The recording uploads while the meeting runs, so it's saved as
  > soon as you stop. You can also send the AlgoMinutes notetaker to a Google Meet, and it joins as your
  > notetaker, visible to everyone.
  >
  > Before every recording you confirm you have permission from everyone on the call. The extension signs in
  > through the AlgoMinutes web app, never with a password of its own.
  >
  > Requires an AlgoMinutes account. This is a beta.

- **Category:** Productivity. **Language:** English.
- **Screenshots** (1280×800): the popup ready to record, the popup recording, and a finished note in the web app.
- **Privacy policy:** https://algominutes.algorythmos.com/privacy (see "Before submitting", below).

### Permission justifications

The Chrome Web Store asks for one per permission; the Edge form asks for the same.

| Permission | Justification |
|---|---|
| Single purpose | Record a meeting from the browser tab it runs in (and the user's microphone) into the user's AlgoMinutes account, or send the AlgoMinutes notetaker to that meeting. |
| `tabCapture` | To record the sound of the meeting tab the user started the recording from (the other people on the call). Only after the user clicks the extension on that tab and confirms everyone agreed to be recorded. |
| `offscreen` | A service worker can't hold a media stream for a whole meeting; an offscreen document records the tab and the microphone and uploads the recording while the meeting runs. |
| `storage` | Keeps the user's sign-in in session storage (memory only) and the state of the current recording, so an interrupted recording can be finished. |
| Host: the AlgoMinutes api | To create the recording's note and upload session, and send the notetaker, as the signed-in user. |
| Host: `storage.googleapis.com` | The recording is uploaded, while it's made, to the upload session the AlgoMinutes api creates in Google Cloud Storage. |
| Host: `meet.google.com` | To know that the tab the popup opened on is a Google Meet, and its link, so the user can send the notetaker to it. No script runs in Meet's page. |
| Remote code | No. Everything the extension runs is in the package. |

### Privacy practices (Chrome Web Store "Privacy" tab)

To be confirmed by the owner and legal before submitting. What the extension handles:

- **Personal communications:** the audio of meetings the user chooses to record, sent to AlgoMinutes to be
  transcribed and summarised, as the privacy policy describes.
- **Authentication information:** the user's AlgoMinutes session, kept in memory only.
- While recording, the last seconds not yet uploaded are also kept in the extension's own browser storage
  (IndexedDB), so a recording the browser closes on can still be saved; they're deleted once it's saved.
- **Website content:** only a Google Meet tab's link, and only when the user sends the notetaker.
- It does not collect web history, location, health or financial data, and it reads no page content.
- Certify: not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not
  used to determine creditworthiness or for lending.

### Before submitting

1. **The privacy policy must mention the extension.** Today it describes the apps and the web app. Add that the
   extension records a browser tab's audio and the microphone at the user's request, uploads it to AlgoMinutes,
   keeps its sign-in in memory only, and reads a Meet tab's link only to send the notetaker. That's a change to
   `apps/site/src/pages/privacy.astro`, for legal review with the rest, and live (a promotion) before the
   listing is submitted.
2. The real-browser check in `apps/extension/README.md`: connect, record a Meet with the microphone, stop, and
   see the note with both sides of the call; then quit the browser mid-recording and see it saved on reopening.
3. Screenshots, the listing text and the justifications above, pasted into each store.

Chrome Web Store review of a `tabCapture` extension can take days to weeks; submit early in Wave 3.

### A new version

1. Raise `version` in `apps/extension/package.json`, build and zip as above.
2. Upload it to both stores. Testers get it automatically once it's approved.
3. To turn away a broken version already installed, raise `MIN_SUPPORTED_CLIENT.extension` in
   `packages/contracts/src/version.ts` above it and deploy the api: that version's calls get the "please update"
   answer (426), and its popup says so.
