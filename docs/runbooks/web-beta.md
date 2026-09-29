# The web beta in Chrome (RELEASE.md PR 16)

Beta testers use the web app at **https://beta.algominutes.algorythmos.com/app**. It's the same app and the same
beta service as the iPhone beta (staging), with the same invite codes. The first part is for testers; the rest is
for whoever runs the beta. Setting up the beta host is `site.md`, "The beta web app".

## For testers

### Start

1. Open **https://beta.algominutes.algorythmos.com/app** in **Chrome** or **Edge** on a computer. Recording a call
   in a tab needs Chrome or Edge. Safari and Firefox can record from the microphone only.
2. **Try it as a guest** (no sign-up), or sign in with Apple or Google. A guest's notes are kept to that
   browser's guest account: **Create account** (top right) keeps them with Apple or Google.
3. **Settings → Plan → Invite code:** enter the code from your invitation (`BETA-…`), then **Add minutes**. The
   record page asks for it too, if you haven't.

### Record a meeting in the room

**Record → This device's microphone**, tick the permission box, **Start recording**. Chrome asks for the
microphone once. Keep the tab open: everything recorded is kept in this browser as you go. **Stop and save**
uploads it and opens the note.

### Record a Google Meet (or any call in a browser tab)

1. Join the call in its own tab.
2. In another tab, **Record → A call in another tab, with my microphone**. Tick both boxes (your permission, and
   everyone on the call agreeing), then **Choose the call's tab**.
3. Chrome asks what to share. Choose **Chrome Tab**, pick the call's tab, and **tick "Also share tab audio"**.
   Without it there's no sound from the call, and the app says so. Then allow the microphone, so your own voice is
   included.
4. While it records you see two meters: **The call** and **You**. If the call's meter stays empty for 15 seconds,
   the app warns you: check the call isn't muted, and that its tab audio was shared. **Mute my microphone** keeps
   your side out of the recording while the call is still recorded.
5. **Stop and save**, or Chrome's own **Stop sharing**, ends it and uploads it.

The Zoom and Teams **desktop apps on a Mac** can't be shared this way. Join those calls in the browser, or record
them with the AlgoMinutes iPhone app.

### If something goes wrong

- **The tab closed, crashed or reloaded mid-recording:** what was recorded is kept in this browser. **Your notes**
  says "A recording wasn't uploaded": **Upload it**. It goes into one note, never two.
- **Closing the tab while recording or uploading:** Chrome asks first. The recording is kept either way.
- **Signing out** with recordings not uploaded asks first: upload them, or they're deleted from this browser.
- **An upload failed:** it's kept in the browser; upload it again from the record page or Your notes.

Your notes are kept for the whole beta, and backed up. The public release starts fresh: you'll be told before
then, with time to export. **Record only people who agreed, and nothing confidential.**

### Send feedback

**Settings → Help & Support**, or reply to your invitation email. Say what you did, what you
expected, and your browser. Your **User ID** (Settings) helps support find your account.

## Running the web beta

- **Invite codes** are shared with the iPhone beta (`testflight-external.md`, "Invite codes"): one per cohort.
- **The e2e** walks the web app in Chrome after each staging deploy and nightly (`.github/workflows/web-e2e.yml`,
  RELEASE.md PR 14b): an import, search and chat, a microphone recording, a reload mid-recording, and a call in a
  fake tab.
- **Before inviting a cohort:** on your own computer, a 30-minute Google Meet recorded from its tab with the
  microphone. Both sides should be in the transcript, the meters should move, and closing the Meet tab should save
  it (Wave 1 proof 6).
- **Feedback** from web testers is triaged with the iPhone beta's, every 48 hours, into GitHub issues labelled
  `beta`.
