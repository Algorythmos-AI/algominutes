# The owner's pack for App Store submission

**For the owner, 2026-10-29.** Checked against `origin/integration` at c2db256b. It covers the steps only the
owner can do: the e-mail to counsel, the Gemini capacity order, proof 5 on a phone, external TestFlight, and
App Store Connect. It doesn't repeat the plans; it links them:
[APP-STORE-LEGAL.md](APP-STORE-LEGAL.md), [APP-STORE-GEMINI-CAPACITY.md](APP-STORE-GEMINI-CAPACITY.md),
[APP-STORE-REVIEW-PACKAGE.md](APP-STORE-REVIEW-PACKAGE.md),
[APP-STORE-XCODE-CLOUD-RELEASE.md](APP-STORE-XCODE-CLOUD-RELEASE.md),
[APP-STORE-DEVICE-LAB.md](APP-STORE-DEVICE-LAB.md), [RELEASE.md](RELEASE.md) ("Status, 2026-10-27", phases
B and C), [CONSENT.md](../CONSENT.md), [BLOCKERS.md](../BLOCKERS.md) §0.

State, updated 2026-10-29 from git and GitHub: promotion #541 is merged to `main` (24adcde7). It carries #532
(kill-safe call capture), #535 (the "Written by Algorythmos AI" label), #537 (the one-time Google Cloud AI
agreement) and #539 (the example note). `deploy-production` for 24adcde7 (run 40907715339) is green: migrate,
api rollout and smoke. The iOS changes reach testers in the next Release build (RC1).

## Checklist

Tick in order where you can; the dates are the deadlines that keep submission on schedule (§4).

**This week (by Fri 10-30)**
- [ ] Send the e-mail to counsel, with the attachments ([§1](#1-e-mail-to-counsel-draft-the-owner-sends-it)).
- [ ] Place the Gemini Provisioned Throughput order ([§2](#2-gemini-capacity-order)); add the DECISIONS line
      ([§2.6](#26-the-decisions-entry)).
- [x] #535 and #537 merged (10-29) and promoted to `main` in #541. Their device runs aren't recorded here; check
      the private test-history repository before RC1.
- [x] Release build against production on the iPhone 11 Pro Max, 10-29: the full UI lane 7 passed, 0 failed, 4
      expected skips; a recording reached Ready in 74 s with a push sent (I10 closed). Runs are in the private
      test-history repository; BLOCKERS §0, 10-29.
- [x] Run proof 5 on the iPhone 11 with a second person ([§3](#3-proof-5-script)); recorded in BLOCKERS §0.
      2026-10-29: failed. iOS gives the broadcast no call audio ([§3.7](#37-the-result-2026-10-29)).

**By Thu 11-05**
- [x] Proof 5 decided (owner, 2026-10-29): "Record a call" is out of 1.0 ([§3.6](#36-if-it-fails),
      DECISIONS.md 2026-10-29).
  - [ ] #555 merged: no extension in the Release build, no call wording in the microphone text. Then a
        `--release` device run ([§3.7](#37-the-result-2026-10-29)).
  - [ ] #555 promoted to `main` before RC1. Production's `broadcast_capture` stays "on" for the web app's call
        in another tab; nothing to apply (#556 only makes an unset switch mean off).
- [x] Promotion `integration` → `main` merged (#541, 24adcde7), `deploy-production` green (run 40907715339,
      2026-10-29) ([XCODE-CLOUD-RELEASE §1](APP-STORE-XCODE-CLOUD-RELEASE.md#1-prerequisites-owner)). If
      proof 5 fails, the extension's removal needs one more promotion before RC1.
- [ ] Xcode Cloud "Release → App Store" build (RC1); checks 1–3 and 10–11
      ([XCODE-CLOUD-RELEASE §4](APP-STORE-XCODE-CLOUD-RELEASE.md#4-what-the-build-enforces-and-what-to-check-on-the-archive)).
- [ ] External group "AlgoMinutes RC" with production Test Information; RC1 added; Beta App Review submitted
      ([§4.1](#41-what-you-click)).
- [ ] Sandbox notification URL → production billing
      (`https://billing-43914754953.australia-southeast1.run.app/webhooks/apple`; RELEASE status decision 4,
      S18), then one sandbox purchase reconciled on prod.
      - 2026-10-29: a sandbox purchase and restore verified on production with the Release build (BLOCKERS §0,
        10-29); no reconcile has checked it yet, and no notification has reached production billing. The
        route accepts Sandbox notifications: set the same URL for Production and Sandbox.

**App Store Connect (any time before submission)**
- [ ] Screenshots: 6.9" (1320 × 2868) required; 6.5" (1284 × 2778) optional, scaled from 6.9" if absent
      ([REVIEW-PACKAGE §3](APP-STORE-REVIEW-PACKAGE.md#3-screenshots)).
      - 2026-10-29: 4 screenshots at 1242 × 2688 (6.5") from the iPhone 11 Pro Max by `StoreScreenshotsUITests`
        (#551, in the merge queue). None at 6.9" yet.
- [ ] Listing fields, description, URLs, category, EULA
      ([REVIEW-PACKAGE §4](APP-STORE-REVIEW-PACKAGE.md#4-listing-copy)).
- [ ] App Review Information: notes (**variant B**: proof 5 failed), contact (typed into ASC only), sign-in not
      required ([REVIEW-PACKAGE §1](APP-STORE-REVIEW-PACKAGE.md#1-paste-ready-for-app-store-connect)). Blocked
      until the app stops paywalling the free floor (REVIEW-PACKAGE, Drift).
- [ ] Promotional text (REVIEW-PACKAGE §1.3). No What's New for 1.0 (§1.2).
- [ ] Age rating questionnaire, answered for **13+**
      ([STORE-COMPLIANCE §7](../STORE-COMPLIANCE.md#7-age-ratings-deliberate-recommendation); counsel S2).
- [ ] App Privacy: the twelve types in [STORE-COMPLIANCE §2](../STORE-COMPLIANCE.md#2-apple-privacy-nutrition-labels-app-store-connect-answers),
      all linked, none tracking. `tests/app-privacy-answers.test.ts` keeps that table equal to
      `PrivacyInfo.xcprivacy`; compare with RC1's Privacy Report.
- [ ] Pricing and Availability: all storefronts **except mainland China** (CallKit; RELEASE status decision 7).
- [ ] Pricing and Availability: "iPhone and iPad Apps on Apple Silicon Macs" **off** (REVIEW-PACKAGE §5, 4.0).
- [ ] Subscriptions `pro.monthly` and `pro.annual`: display names and descriptions from REVIEW-PACKAGE §1.4, a
      review screenshot of the paywall each, status Ready to Submit, attached to version 1.0 (§5, 3.1.2).
- [ ] Version release: **manual**, phased release on (RELEASE status decision 8).

**Phase C (11-06 → 11-13) and submit**
- [ ] 7 days crash-free ≥ 99.5% and 7 green nights on RC1 ([§4.2](#42-the-7-day-gate)).
- [ ] Counsel signed, or a dated DECISIONS entry to launch on the drafts; site edits merged, "in beta" gone
      ([LEGAL §5](APP-STORE-LEGAL.md#5-after-sign-off)).
- [ ] Re-check App Privacy and age rating after sign-off; select RC1 on version 1.0; Submit for Review.

## 1. E-mail to counsel (draft, the owner sends it)

Attach PDFs of: `docs/plans/APP-STORE-LEGAL.md` (the package; its §2 lists every document), `docs/CONSENT.md`,
`docs/DATA-RETENTION.md`, `docs/STORE-COMPLIANCE.md`. Fill in the two bracketed fields. Nothing else to edit.

**Subject:** AlgoMinutes: sign-off on Terms, Privacy Policy and recording consent before App Store submission
(answers needed by 6 November, final by 13 November)

```
Hello [name],

We're preparing to submit AlgoMinutes, our iPhone app, to the App Store. It records a meeting on the user's
phone, transcribes it, and uses Google's Gemini models (Vertex AI, in Sydney) to write a summary, action items
and decisions. 1.0 sells auto-renewing subscriptions through the App Store after a 7-day free trial.

We need your sign-off, or the changes you require, on the Terms of Service, the Privacy Policy and our
recording-consent posture. Our last date is Friday 13 November 2026. If you can answer the questions below by
Friday 6 November, we can make any changes inside our test period instead of after it.

The live documents:
- Terms of Service: https://algominutes.algorythmos.com/terms
- Privacy Policy: https://algominutes.algorythmos.com/privacy
- Account deletion: https://algominutes.algorythmos.com/delete-account

Attached: our review package (it explains the product, where data is processed and every open question),
our recording-consent policy (CONSENT), data retention, and the App Store privacy declarations.

Questions we need answered before launch (the package has the detail and our current position on each):
L1  Are the Terms and Privacy Policy approved for 1.0, subject to the changes in the package (section 4)?
L2  Are /terms, /privacy and /delete-account the final links for the App Store listing and the app?
L3  Does our "Information sent outside Australia" wording, and our choice of providers, meet APP 8.1?
R1  Is a 30-day window to delete backups after account deletion acceptable, with the wording we use?
R2  Is retention described consistently in the microphone prompt, the Policy and the deletion page?
R3  How long must we keep billing and tax records after an account is deleted?
R4  Is there any other legal minimum or maximum retention for recordings, notes or logs?
R5  Do product-usage events need a time limit, or may they be kept until the account is deleted?
C1  Please map recording-consent law by Australian state and territory, and for our launch markets: does a
    user who is a party to the conversation need everyone's consent?
C2  Is our pre-recording affirmation adequate for launch, and should it link the Terms and Privacy Policy?
S1  Are our App Store privacy answers (attached, section 2) approved?
S2  Is 13+ the right age rating?
S3  Do Apple's user-generated-content rules apply to a private, single-user notes app with sharing off?
S4  Do we need an age gate at sign-up, and at what age?
S5  Are "AI Meeting Notes" in the app name, and our keywords, safe given the consent posture?

Two changes we made today, for your view:
1. Every summary, transcript and AI answer is labelled "Written by Algorythmos AI", in the app and on every
   export and share, and exported files carry a machine-readable "AI-generated" mark. Is that enough under the
   Australian Consumer Law, and for the EU AI Act's transparency rule?
2. Before anything is first sent for AI processing, the app now asks once, separately from the recording
   tick:
   "Send your recordings to Google Cloud AI?
   To transcribe and summarise, AlgoMinutes sends your audio and its text to Google Cloud's speech and AI
   services (Gemini). Documents you scan and questions you ask about your notes go there too.
   Google doesn't use it to train its models. You can delete a note at any time, and turn this off in
   Settings."
   Buttons: "Agree and continue" / "Not now", with a link to the Privacy Policy. It can be turned off in
   Settings. Does this wording meet Apple's guideline 5.1.2(i) (explicit permission before personal data is
   shared with a third-party AI service) and the Privacy Act (notice under APP 5, use and disclosure under
   APP 6)? It is stored per device, not per account.

One thing we already know must change: the Terms still say "AlgoMinutes is in beta" (section 1), "free during
the beta" (section 8) and "as is during the beta", the Privacy Policy says "Nothing is sold during the beta",
and both pages carry a "pending legal review" banner. We'll remove these at sign-off; please tell us what the
subscription, trial, renewal and refund terms must say in their place.

If sign-off can't be given by 13 November, please tell us the risk of launching on the current documents,
so we can record that decision.

Questions marked [later] in the package gate features that are off for 1.0; they can wait.

Thank you,
[sender]
Algorythmos Pty Ltd
```

Notes for the owner, not for the e-mail:
- The agreement text is #537's copy. If #537 changes its words before you send, paste the new ones.
- Both changes are merged and on `main` (#541); they reach a build with RC1.
- The beta wording is in `apps/site/src/pages/terms.astro` (lines 19–22, 69, 94), `privacy.astro` (line 74) and
  `apps/site/src/components/LegalNotice.astro`. Removing it is LEGAL §5 step 2.
- **The Terms and Privacy versions are compiled into the app** (`apps/ios/AlgoMinutes/Services/ComplianceContract.swift`
  mirrors `packages/contracts/src/limits.ts`). Any Terms or Privacy change after RC1 is an iOS change and, by
  RELEASE.md Phase C, restarts the 7 days. That is why the e-mail asks for answers by 6 November (§4.3).

## 2. Gemini capacity order

Sources, all read on 2026-10-29 (each page says "Last updated 2026-10-28 UTC"):
- [P1] Gemini 3.5 Flash model page:
  https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-5-flash
- [P2] Provisioned Throughput supported models:
  https://docs.cloud.google.com/vertex-ai/generative-ai/docs/provisioned-throughput/supported-models
- [P3] Purchase Provisioned Throughput:
  https://docs.cloud.google.com/vertex-ai/generative-ai/docs/provisioned-throughput/purchase-provisioned-throughput
- [P4] Pricing: https://cloud.google.com/vertex-ai/generative-ai/pricing
- [P5] Priority PayGo: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/priority-paygo

### 2.1 What Google's docs say

- **Provisioned Throughput is offered for gemini-3.5-flash in australia-southeast1** [P1, "Supported
  regions › Provisioned Throughput"]. So this is the route, not the quota form.
- **There is no quota to raise.** [P1] lists "Fixed quota: Not supported" for 3.5 Flash. That matches what
  GEMINI-CAPACITY §2 measured (no quota row in Sydney). The quota-increase route in GEMINI-CAPACITY §4 doesn't
  apply.
- **Priority PayGo isn't available in Sydney.** It runs on the global, `us` and `eu` endpoints [P5]; for 3.5
  Flash [P1] lists the same three. Using it would move processing out of Australia, which needs the privacy
  changes in GEMINI-CAPACITY's owner decisions. Not an option for 1.0.
- **One GSU** of gemini-3.5-flash gives 675 tokens a second. Burndown: input text 1, input audio 1, output 6.
  Minimum purchase 1 GSU, increment 1 [P2].
- **Terms:** 1 week, 1 month, 3 months, 1 year. Not cancellable for the term. Weekly terms don't auto-renew.
  An order goes Pending review → Approved → Active, "from a few minutes to a few weeks", subject to capacity;
  billing starts when Active. A start date up to two weeks ahead can be set [P3].
- **Traffic above the order spills over to pay-as-you-go** by default [P2]. That spill-over is the shared
  capacity that returns 429 today.
- Not verified: whether reasoning ("thinking") tokens burn down as output for 3.5 Flash. [P2] shows "+6
  reasoning" for some models and not for 3.5 Flash.

### 2.2 Sizing and price

Load per request from GEMINI-CAPACITY §3: about 12,000 input tokens (mostly audio) and 1,500 output.
Burndown per request = 12,000 × 1 + 1,500 × 6 = **21,000**.

Price per GSU, "Non-Global" column (Sydney is a regional endpoint; [P4] says non-global pricing applies to GA
Gemini 3 and later from 1 July 2026). [P4] gives hourly prices; a month here is 730 hours.

| Term | Per GSU-hour [P4] | Per GSU, a month | Per GSU, a week |
|---|---|---|---|
| 1 week | US$7.854 | — | US$1,319.47 (× 168 h) |
| 1 month | US$4.068493151 | US$2,970.00 | — |
| 3 months | US$3.616438356 | US$2,640.00 | — |
| 1 year | US$3.01369863 | US$2,200.00 | — |

| Sized for | Peak QPS (CAPACITY §3) | Burndown/s | GSUs | 1-month term, a month |
|---|---|---|---|---|
| 1 GSU, the floor | 0.032 (about 1.9 requests a minute) | 675 | 1 | US$2,970 |
| 100 users a day | 0.05 | 1,050 | 1.56 → **2** | **US$5,940** |
| 1,000 users a day | 0.5 | 10,500 | 15.6 → 16 | US$47,520 |

For comparison, ordinary pay-as-you-go at the same load (non-global 3.5 Flash: US$1.65 per million input
tokens, US$9.90 per million output [P4]), with CAPACITY §3's 6 requests per user per day:
- 1,000 users: 6,000 × 12,000 = 72 M input × 1.65 = US$118.80; 6,000 × 1,500 = 9 M output × 9.90 = US$89.10;
  US$207.90 a day, **about US$6,320 a month** (× 30.4).
- 100 users: about **US$632 a month**.

So Provisioned Throughput sized for the peak costs about 7.5 times the tokens it buys: CAPACITY §3 sizes for a
peak minute of 0.5% of the day, about 7 times the average. It buys freedom from 429s, not cheaper tokens.

Prices are in US dollars; the AUD amount on the invoice is not verified. All of these are well above
production's A$500 monthly budget alert (`infra/terraform/envs/prod/main.tf`, `monthly_budget`), so the alert
will fire. The A$60 daily cap counts audio minutes, not the GSU fee, so it won't stop anything.

### 2.3 Recommendation: the smallest sensible commitment

**2 GSUs, 1-month term, auto-renew off, start date the day RC1 reaches external testers (about 11-04): about
US$5,940.** It covers CAPACITY §3's 100-users-a-day peak, the soak and the first weeks of a phased release;
anything above it still runs on shared capacity, as today. Review it at day 21 with the measured 429 rate, and
renew, resize or drop it then.

This replaces GEMINI-CAPACITY's default of "sized for 1,000 users a day": at 16 GSUs that is about US$47,520 a
month. Order that size only when daily users approach 800 (CAPACITY §5's resize trigger).

A cheaper first step is 1 GSU (US$2,970 a month), about 1.9 requests a minute at peak. One 10-minute recording
alone burns about 29,000 tokens (19,200 audio + 1,000 prompt + 1,500 × 6). How a GSU handles a burst above its
per-second rate is not verified.

### 2.4 Click path

Project `algominutes-production` (43914754953). Steps from [P3]; labels as Google documents them, not checked in
the console.

1. console.cloud.google.com, select project `algominutes-production`.
2. Search "Provisioned Throughput" (Vertex AI) and open the **Provisioned Throughput** page.
3. **New order**. **Order name:** `prod-gemini-3-5-flash-syd-launch`.
4. **Model:** `gemini-3.5-flash` (orders apply to that model version ID, not an alias [P2]; it is the ID in
   `packages/ai/src/models.cjs`). **Region:** `australia-southeast1`.
5. **Estimation tool**: QPS 0.05, input 12,000 (about 80% audio), output 1,500. Read **Estimated GSUs and
   monthly prices**. **Use calculated**, then set **Number of GSUs** to **2**.
6. **Term:** 1 month. **Start date and time:** the RC1 external TestFlight day. **Renewal:** off.
7. **Continue**. In **Confirm and submit**, check the price is about US$5,940 (2 × US$2,970). If it differs,
   record the console's figure, not this one.
8. Type `CONFIRM` in **Purchase confirmation**, then **Submit order**.
9. Watch the order's status. If it sits in Pending review past 11-03, open a support case (Support › Create
   case › Vertex AI) with GEMINI-CAPACITY §3's justification text, recounting the production figures first.

Proof it works, once Active: the production logs show `gemini_ok` and few `gemini_rate_limited`; a
2-minute note reaches `ready` in a few minutes. Engineering reads the logs and records it in BLOCKERS §0 (S17).

### 2.5 If Google refuses or it stays pending

GEMINI-CAPACITY §5. In short: launch with small invite waves and the phased release; the retry window (5
attempts on a 429, Cloud Tasks retries) is the mitigation; record the single-model risk in DECISIONS. Melbourne
(australia-southeast2) only if a probe shows 3.5 Flash served there, and only with `processing.json`, the
Privacy Policy and a DECISIONS entry first. [P1] does not list australia-southeast2 for 3.5 Flash. Don't submit
while S17 is open: the review notes promise "usually ready within a few minutes" (REVIEW-PACKAGE §1.6).

### 2.6 The DECISIONS entry

Add under a heading "Gemini capacity for launch (2026-10-29)":

```
- **Decision.** Ordered Provisioned Throughput for gemini-3.5-flash in australia-southeast1 on algominutes-production: 2 GSUs, 1-month term, no auto-renew, start <date>, about US$5,940 (US$4.068493151 per GSU-hour non-global, Vertex pricing page read 2026-10-29); order <name>, status <Pending/Approved>; sized for 100 users a day at peak; review at day 21; resize above 5% 429s in a day or 800 users a day; the 2026-09-28 condition "revisit if gemini_transient fires in production" was met on 2026-10-27; if refused, small waves and the retry window, single-model risk accepted.
```

## 3. Proof 5 script

Proof 5 (RELEASE.md R12.4 §2, REVIEW-PACKAGE §6): a real call captured by the broadcast extension, the
extension killed mid-call, and the app picks up what was captured and makes a note of it. #532 makes the
capture survive a kill (fragmented MP4, at most the last ~2 s lost). Its evidence is an in-process test; a real
kill on a phone hasn't been run.

### 3.1 How the extension is killed

The repo has no documented on-device kill. #532's test simulates one by abandoning the writer in-process, and
`BroadcastHandoff.swift` treats an extension as killed when its heartbeat (every ~3 s) is silent for 30 s
while `isBroadcasting` is still set. None of these count as a kill:
- **Stop from the red indicator or Control Center**: a normal finish, `finishWriting` runs.
- **Memory pressure**: can't be produced on purpose.
- **Rebooting the phone**: kills the app and the call too, so it doesn't test the pickup.

What does: **send SIGKILL to the extension's process from the Mac**, with Xcode's `devicectl`, while the call
and the broadcast keep going. That is what iOS's memory limit does. This method is not verified on this
project; it needs a development-signed build (§3.2).

### 3.2 Before you start

- The **iPhone 11** (the lab phone), paired to the Mac by USB, Developer Mode on, unlocked, Auto-Lock Never. No
  lab run at the same time (the lab isn't scheduled yet; DEVICE-LAB D7).
- A **Debug** build of `integration`'s head installed on it from this Mac (it talks to **staging**, where
  `broadcast_capture` is on). Install it as the device runs do: `apps/ios/scripts/device-tests.sh --lane unit
  --only AlgoMinutesTests/BroadcastKillSafeCaptureTests` builds, installs and runs #532's test; the Debug app
  stays installed afterwards (not verified; if not, Xcode › scheme AlgoMinutes › Run). It must include #532;
  include #537 too if it has merged, so the run sees RC1's sheets.
- Signed in to an account with staging minutes (a guest on staging has none; DEVICE-LAB §1).
- A **second person on a second phone**, for FaceTime or WhatsApp. They know they're being recorded.
- On the Mac, **Console.app** with the iPhone selected, filter `subsystem:com.algorythmos.algominutes` and
  `broadcast`. Start streaming.
- A terminal. Find the phone's identifier once (it stays on your Mac; never paste it into the repo):
  `xcrun devicectl list devices`.

### 3.3 Steps

1. Open AlgoMinutes once, so `v1/config` is fresh. Agree to the Google Cloud AI sheet if it shows.
2. Start a **FaceTime** call (or WhatsApp) with the second person. Speakerphone off.
3. Open **Control Center**, long-press **Screen Recording**, choose **AlgoMinutes**, turn **Microphone on**,
   tap **Start Broadcast**. The red indicator appears after the countdown.
4. Talk for **2 minutes**, both of you. Say the time out loud at the start and at 1:30 ("one minute thirty"), so
   the transcript shows how much was kept.
5. At about 2:00, **with the call still going**, on the Mac:
   ```bash
   xcrun devicectl device info processes --device <phone-id> --search BroadcastExtension
   xcrun devicectl device process signal --device <phone-id> --pid <pid> --signal SIGKILL
   ```
   Console should show the extension's log lines stop. The red indicator should go away (not verified: iOS
   may show its own "broadcast stopped" alert).
6. Keep talking 15 seconds, then end the call.
7. **Wait at least 30 seconds** (the stale-heartbeat window), then open AlgoMinutes.

If step 5's `signal` is refused: Xcode › Debug › Attach to Process › BroadcastExtension, then Debug › Stop
(kills the attached process; not verified). Write down which method you used.

### 3.4 What to check

| # | Check | Pass |
|---|---|---|
| 1 | Console, when the app opens | `broadcast_extension_died claiming_partial=true`, then `broadcast_claimed seconds=N` with N about 120 |
| 2 | The app | It asks for the consent tick for the capture (and the AI agreement, if not given), then a note appears |
| 3 | The note plays | Duration about 2:00, at most a few seconds short; it plays to the end |
| 4 | Transcript | Both voices (yours and the far side); "one minute thirty" is in it |
| 5 | Summary | The note reaches ready with a summary |
| 6 | Once only | Reopen the app: no second note from the same capture |

Not a pass: "The capture stopped unexpectedly and couldn't be saved", a note of 0–2 s, or no note.

If only your voice is in the transcript, the kill-survival part still passes, but call capture doesn't do what
it says. Record it and decide as for a failure. Whether FaceTime and WhatsApp let ReplayKit hear the far side
is not verified on this phone.

Then ask engineering to confirm from staging logs that the note's trace reached `ready` with one kickoff.

### 3.5 Record it in BLOCKERS §0

Under "2026-10-27: production runs end to end", a new item (no phone ids, names or numbers):

```
  - [x] Proof 5 (I3, O10), 2026-MM-DD: iPhone 11, iOS 27.0.1, Debug build <sha> against staging; FaceTime call
    with a second phone; broadcast started from Control Center; extension killed at ~2:00 with
    `devicectl device process signal SIGKILL` (or: Xcode attach and stop); app opened after 30 s.
    Console: `broadcast_extension_died claiming_partial=true`, `broadcast_claimed seconds=<N>`.
    Note <noteId> ready, <m:ss> of audio, both voices in the transcript; trace <first 8 chars>.
    Decision: "Record a call" stays in 1.0 / is removed (REVIEW-PACKAGE §6).
```

Use `[ ]` and "failed: <what you saw>" if it didn't pass.

### 3.6 If it fails

Deadline: **Thu 11-05** (RELEASE status decision 3). If it fails, or isn't run by then, REVIEW-PACKAGE §6
applies, all before RC1:
1. Remove the Broadcast Upload Extension from the Release build (`apps/ios/project.yml`; keep it for Staging).
2. Set production `broadcast_capture` to "off" through a reviewed plan and apply; redeploy after (a saved plan
   resets Cloud Run images). (Superseded 10-29: the build flag does this for the iPhone and the switch stays on
   for the web; §3.7.)
3. Drop "or your side of a call in another app that you choose to capture" from `NSMicrophoneUsageDescription`
   and from STORE-COMPLIANCE §4.2.
4. Paste REVIEW-PACKAGE §1.1 variant B (CALL CAPTURE: "no call capture").

If it passes: leave the switch on, paste REVIEW-PACKAGE §1.1 variant A.

### 3.7 The result (2026-10-29)

**Failed. "Record a call" is out of 1.0** (owner decision, DECISIONS.md 2026-10-29). The run used the iPhone
11 (iOS 27.0.1) with the fixed extension (#553), broadcasting during a WhatsApp call. The extension's capture
statistics:
- microphone: 0 buffers in 57 s;
- app audio: 2,400 buffers, all at -99 dBFS (digital silence);
- no drops and no conversion failures.

iOS keeps call audio out of screen broadcasts (FaceTime and phone calls the same), so there was nothing to
capture. The run is in the private test-history repository.

The §3.6 steps:
1. The extension is out of the Release build: **#555** (`CALL_CAPTURE_ENABLED "NO"`; the copy phase leaves it
   out, a build phase checks it; Staging and Debug keep it).
2. Not needed: production's `broadcast_capture` **stays "on"** (your decision, 10-29). It keeps the web app's
   call in another tab; the App Store build has no call capture whatever it says (#555). Nothing to apply.
3. The microphone text's call clause is gone from Release, and from STORE-COMPLIANCE §4.2: **#555**.
4. REVIEW-PACKAGE §1.1 **variant B** is the one to paste.

Device runs to do after #555 merges, from the repository root on the Mac:
```bash
apps/ios/scripts/device-tests.sh --check
apps/ios/scripts/device-tests.sh --lane unit --only AlgoMinutesTests/StoreBuildTests --only AlgoMinutesTests/AppSwitchesTests --only AlgoMinutesTests/BroadcastHandoffTests
apps/ios/scripts/device-tests.sh --release
```
After the `--release` run, look at the Release app installed on the phone. "Before you record" has no "Record
a call" button. Control Center › Screen Recording lists no AlgoMinutes. iOS's microphone prompt, on a fresh
install, doesn't mention calls.

## 4. External TestFlight and the earliest honest submit date

### 4.1 What you click

App Store Connect › Apps › AlgoMinutes › TestFlight.

1. **External Testing › +**: a new group **AlgoMinutes RC** (not "AlgoMinutes beta", whose testers run staging
   with invite codes; XCODE-CLOUD-RELEASE §2).
2. Add testers: at least 20 (Phase B), by e-mail or a public link with a cap.
3. **Test Information** (English, and English (Australia) if offered): a production description, without the
   staging sentences in `docs/runbooks/testflight-external.md`:
   > AlgoMinutes records a meeting on your iPhone and turns it into a summary, decisions, action items and a
   > searchable transcript. This is the release candidate, on our live service. A new iPhone gets 7 days of Pro
   > minutes with no payment, then 120 free minutes a month. Record only people who agreed, and nothing
   > confidential.

   The last free-minutes clause holds only once the app stops paywalling the free floor (REVIEW-PACKAGE,
   Drift); drop it if RC1 ships without that fix.

   Privacy Policy URL `https://algominutes.algorythmos.com/privacy`; feedback e-mail: the support address.
4. **Beta App Review Information**: your contact details (in ASC only); sign-in not required; notes = the App
   Review Notes variant in REVIEW-PACKAGE §1.1 (no invite code: Release has `INVITE_CODES_ENABLED NO`).
5. Open the group › **Builds › +** › the RC1 build (1.0.0, number above 76). Check **What to Test** is filled
   (written by `ci_post_xcodebuild.sh` for en-US and en-AU); edit it for testers if it reads like a changelog.
6. **Submit for Review**. External testers get it after Beta App Review approves (Apple's turnaround not
   verified; plan for one to two days).

### 4.2 The 7-day gate

RELEASE.md R12.2 and Phase C: **crash-free ≥ 99.5% over 7 days on the candidate, counting jetsam, hangs and
background kills**, and the nightly e2e and the web journey **green 7 nights running**. A code change to the
candidate restarts the 7 days.

Where to read it:
- **Firebase console › `algominutes-production` › Crashlytics**, app `com.algorythmos.algominutes`, filter
  version **1.0.0 (N)**, last 7 days: crash-free users and crash-free sessions; Non-fatals for MetricKit's
  hangs and exits (H15 sends jetsam, watchdog and background kills there). This is the number of record.
- **App Store Connect › TestFlight › Crashes** for the build, and Xcode › Organizer › Crashes: a cross-check.
- **GitHub Actions**: the scheduled nightly e2e and `web-e2e.yml` runs, 7 green in a row.

Owner decision: **crash-free sessions** as the gate, not users. With about 20 testers one crashing user is 95%
crash-free users, so the users figure can't reach 99.5% with any crash at all. Record which one in DECISIONS
before the soak starts.

### 4.3 Timeline from today

| Date | Step | Owner |
|---|---|---|
| Thu 10-29 | E-mail to counsel; Gemini order placed | Owner |
| Thu 10-29 | Proof 5 run: failed; call capture out of the iPhone's 1.0 (#555) | Owner + one person |
| Mon 11-02 | The free-floor fix and #555 merged; #535, #537 done 10-29 | Owner merges |
| Tue 11-03 | Promotion to `main` green, prod deploy; Xcode Cloud RC1 build; archive checks; Beta App Review submitted | Owner |
| Wed 11-04 | Beta App Review approves; testers install; Gemini order Active; soak day 1 | Apple, Google |
| Thu 11-05 | Phase B deadline: proof 5 decided, ≥ 20 testers | Owner |
| Fri 11-06 | Counsel's answers asked for | Counsel |
| Tue 11-10 | Soak day 7 ends (11-04 → 11-10); 7th green night | — |
| Fri 11-13 | Legal cut-off | Counsel |
| **Mon 11-16** | **Earliest honest submit**, with a phased release | Owner |
| Mon 11-23 | Likely submit, if RC2 is needed | Owner |

**Earliest: Mon 16 November**, if all of these hold:
- the Gemini order is Active by 11-04 and production notes finish in minutes (S17 closed);
- #555 is in RC1 (proof 5 is decided: call capture is out), so RC1 doesn't change for it;
- Beta App Review approves within a day;
- RC1 has no crash fix in the 7 days;
- counsel answers by 11-06 **and** what they ask for needs no app change, or you decide before the soak that
  bumping only the Terms/Privacy version constants doesn't restart the 7 days (record it in DECISIONS).

On paper the soak ends 11-10, so 11-11 is possible only if legal has already signed. With the legal cut-off on
11-13 and its site edits, 11-16 is the first honest date. RELEASE.md Phase D says the same: best case 11-16,
likely 11-23.

What moves it:
- **Legal.** Answers after 11-06, or changes to the app's text, mean RC2 and a new 7 days: about 11-23. A
  missed 11-13 cut-off needs a dated decision to launch on the drafts.
- **Gemini capacity.** Without an Active order, S17 stays open and you shouldn't submit.
- **#555 missing RC1.** Removing the extension is a code change: if RC1 is cut without it, RC2 and a new soak.
- **Any crash or code fix in RC1**: RC2, new soak.
- **Beta App Review** taking several days, or rejecting the production Test Information.
- **The free-floor fix** slipping past 11-02: RC1 waits for it, day for day (#535 and #537 are already on `main`).

## Not verified

- Console labels for Provisioned Throughput (taken from Google's docs, not the console); how long Google takes to
  approve; the AUD amount; whether reasoning tokens burn down as output for 3.5 Flash; how a GSU handles bursts.
- That `devicectl ... signal SIGKILL` (or Xcode attach and stop) kills the extension on iOS 27.0.1, and what iOS
  shows when it does. That the Debug app stays installed after `device-tests.sh`.
- Whether FaceTime and WhatsApp audio reach the extension.
- Beta App Review turnaround; Crashlytics' exact labels for crash-free users and sessions.
- That a sandbox notification reaches production billing (S18). The code accepts one (`webhooks/apple.js` checks
  no environment); none has arrived yet.
- That `pro.monthly` and `pro.annual` have their review screenshots and are Ready to Submit.
