# ADR 0002: the Chrome and Edge extension

- **Status:** proposed (RELEASE.md PR 32, Wave 3). It becomes accepted when the owner signs it off.
- **Date:** 2026-09-30
- **Plan:** `docs/plans/RELEASE.md` Wave 3 (PRs 33–38), `docs/plans/MEETINGS.md` M3.

## Context

Testers on a laptop record a Google Meet in two ways today. The web app can capture the Meet tab (the tester
picks the tab in Chrome's share dialog and ticks "Also share tab audio"), and the notetaker bot can join the
meeting. Both work, but neither is one click from the meeting itself. Wave 3 adds a browser extension for
Chrome and Edge that records the Meet tab, or sends the notetaker, from the meeting.

The web app already has most of what a recording needs: the upload session API, the kickoff, the consent
gate, the notes. The extension must reuse them, not grow a second pipeline.

## Decision

One Manifest V3 build for Chrome and Edge (`apps/extension`), with these parts.

### 1. Capture: `chrome.tabCapture` in an offscreen document

- The service worker asks `chrome.tabCapture.getMediaStreamId({ targetTabId })` for the Meet tab. The offscreen
  document (`chrome.offscreen`, reason `USER_MEDIA`) turns the id into a stream with `getUserMedia` and records
  it. A service worker can't hold a media stream or stay alive for an hour; an offscreen document can.
- **The tab and the microphone are separate channels.** The tab's audio is the other people; the microphone
  is the tester. They're mixed into one recording, as the web app's call capture does, and the tab's audio is
  also played back into the tab (a captured tab goes silent otherwise).
- **Starting needs the user to invoke the extension.** Chrome grants a tab-capture stream id only after the
  user clicks the extension's toolbar button (or its keyboard shortcut, or its context menu). A button a
  content script draws on the Meet page does not count. So recording starts from the toolbar popup; the
  in-page button sends the notetaker, or points to the toolbar. *To confirm in the first spike, on Chrome and
  Edge.*
- **The microphone permission** is asked once, from an extension page opened in a tab, because an offscreen
  document can't show a permission prompt. *To confirm in the spike.*

### 2. Upload: progressive, as the web app will (PR 33, R3)

- `MediaRecorder` chunks go to an unknown-length resumable upload session while recording, so the upload is
  finished within seconds of Stop, not after a 60-minute file is assembled.
- Chunks not yet acknowledged are kept in the extension's IndexedDB, so a browser crash or restart leaves a
  recording that resumes or is reported, never silently lost (as the web recorder does since PR 12).
- The note is created server-side by `POST /v1/notes` (PR 35, reusing `createServerNote`); the extension never
  writes Firestore. Stop calls `/v1/uploads/{id}/complete`, then `/v1/process`.

### 3. Sign-in: a one-time code from the signed-in web app (PR 34)

The extension never asks for a password or runs its own OAuth.

1. The tester opens the web app's "Connect the extension" page while signed in. The extension has made a
   random verifier and sent the web app only its SHA-256 (over `externally_connectable`).
2. The web app asks `POST /v1/auth/extension-link` for a code: one use, 60 seconds, bound to the uid, the
   extension's id and the verifier's hash.
3. The web app passes the code to the extension over `externally_connectable`, which lists the exact web
   origins. The extension checks `sender.origin` against them, and nothing else can message it.
4. The extension exchanges the code and its verifier for a Firebase custom token, and signs in with it. The
   session lives in `chrome.storage.session` (memory only, cleared when the browser closes), never in
   `chrome.storage.local`.
5. Signing out of the web app signs the extension out: the web app sends a sign-out message, and the api
   revokes the refresh tokens on account deletion.

### 4. Consent: the same gate as the web app

Before every recording, the popup shows the web app's two ticks, word for word: "I have permission from anyone
whose voice may be captured…" and, for a call, "Everyone on the call has agreed to be recorded."
(`docs/CONSENT.md` §2.2). Sending the notetaker shows its own affirmation (§2.4), as the web's `/notetaker`
page does. While recording, the toolbar badge shows it, and the popup shows a timer and Stop.

### 5. Permissions, and why each is needed

| Permission | Why |
|---|---|
| `tabCapture` | The Meet tab's audio (the other people on the call) |
| `offscreen` | A document that can hold the media stream and record for the whole meeting |
| `storage` | The session (`chrome.storage.session`) and the popup's settings |
| `host_permissions: https://meet.google.com/*` | The in-page button, and knowing which tab is a Meet |
| `host_permissions` for the api origin and `https://storage.googleapis.com/*` | The api calls and the resumable upload. *Whether GCS answers the extension's origin with CORS is confirmed in the spike; the host permission covers it either way* |

Nothing else: no `tabs` (the popup captures the tab it was opened on), no `<all_urls>`, no `identity`, no
`scripting` beyond the declared content script, and no remote code (MV3 forbids it; the CSP is the default).

### 6. Versions, switches and CORS (PR 36, Apply C)

- The client header is `extension/x.y.z`, and `extension` is in `MIN_SUPPORTED_CLIENTS` from the first release,
  so a broken build can be turned away with the "please update" answer (426).
- The notetaker button follows `/v1/config.notetaker.extension`, which is reported on only once it's built.
- `ALLOWED_ORIGINS` lists both the Chrome and the Edge extension origins: their ids differ, and the allowlist is
  exact.

### 7. Stores

Submitted **unlisted** to the Chrome Web Store and **hidden** in Edge Add-ons, and installed by testers from
the link in their invite. `tabCapture` means a longer review, so it's submitted early in Wave 3. The listing,
the permission justifications and the privacy-practices answers are in PR 38's runbook.

## What leaves the browser

- The recording (tab and microphone mixed), to Cloud Storage through the api's upload session, as every other
  recording does. Nothing is sent anywhere else.
- The note's metadata (its title, duration and platform), to the api.
- No page content, no URL beyond knowing a tab is a Meet, and no analytics beyond the existing funnel events.

## Alternatives considered

- **Tab capture in the web app only** (today): works, but it's three steps (open the app, pick the tab, tick
  "share tab audio"), and a tester who forgets the tick records silence. The extension is one click.
- **`getDisplayMedia` from the extension:** shows the same picker as the web app; no better than today.
- **Capturing audio in a content script:** a page can't capture its own tab's output audio. Rejected.
- **The notetaker only:** needs a bot in the meeting, which some meetings refuse or hold in the lobby, and costs
  Recall minutes. The extension needs no bot.
- **A desktop app (Mac):** records any app, including desktop Zoom and Teams, but it's a bigger build and a
  separate distribution. It stays M5 (after launch).

## Consequences

- A fourth client surface: its own CI (build, lint, unit tests, Playwright with the extension loaded and fake
  media), its own version gate, and its own store reviews.
- Meet's page changes can break the in-page button; they can't break recording, which only needs the tab.
- The web app's progressive upload (PR 33) is built first and shared, so both surfaces behave the same.

## Revisit when

- Chrome or Edge changes `tabCapture` or the offscreen document's lifetime rules.
- The spike finds the microphone or the upload's CORS needs another shape.
- Zoom web or Teams web is added: the content script's host permissions grow, and the store listings change.
