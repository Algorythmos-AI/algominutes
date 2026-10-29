# Legal review package for App Store 1.0

**Draft for the owner, 2026-10-29.** Checked against `origin/integration` at aa7a8e38. It organises questions
for a qualified lawyer; nothing in it is legal advice. A "current default" describes what the product or
documents do today, not a view that it is lawful. The plan's legal gate is RELEASE.md "Status, 2026-10-27"
(Phase C, decision 6) and R12.5 Stage 5.

## Owner decisions

- **Send this package to counsel now**, with the cut-off **Fri 13 November 2026** (RELEASE.md status decision
  6). Default: send it this week.
- **If sign-off misses 13 November:** default (RELEASE.md Phase C) is **a dated owner decision in
  `docs/DECISIONS.md` to launch on the current drafts**, with counsel's view of that risk requested in the same
  letter.
- **EULA:** **Apple's standard EULA** plus our Terms linked in the description, unless counsel asks for a
  custom one (R12.5 Stage 5 lists "the EULA").

## 1. Cover memo

**To:** [Counsel] · **From:** Algorythmos Pty Ltd (ABN on the Terms page), Sydney NSW · **Re:** sign-off on the
AlgoMinutes Terms of Service, Privacy Policy and recording-consent posture before App Store submission.

**What the product does.** An iPhone app and web app. A user records a meeting or voice note on their device
(or imports audio, or scans text); the service transcribes it and uses Google's Gemini models to write a
summary, action items, decisions and chapters, with search and Q&A over the user's own notes. Each recording is
private to the account that made it. Before every recording the user must tick "I have permission from anyone
whose voice may be captured…". A meeting "notetaker" bot (Recall.ai) exists but is limited to allowlisted
testers until a consent opinion is received.

**Where data is processed** (the Privacy Policy's processors table, `apps/site/src/data/processing.json`):

| In Sydney (australia-southeast1) | Outside Australia, or global |
|---|---|
| Recordings (Cloud Storage); notes and accounts (Cloud SQL Postgres); note cache (Firestore); Gemini summaries, short-recording transcription and embeddings (Vertex AI) | Speech-to-Text for longer recordings (Google global endpoint); Firebase Auth; push (FCM, APNs); Crashlytics; Cloud Logging (30 days); Recall.ai notetaker (Tokyo, testers only, deleted on ingest, 72 h max); Apple App Store and Stripe |

No advertising or third-party analytics SDK; the app's own product events are declared as Analytics. Card
numbers and similar identifiers are scrubbed from transcript text before AI processing; audio is sent as
recorded. Content is not used to train models.

**Users.** General audience; provisional App Store rating **13+**; the Terms require 13+ and capacity to
contract locally. No age gate at sign-up. Sign in with Apple, Google, or as a guest.

**Markets.** All storefronts **except mainland China** (RELEASE.md status decision 7). iPhone only. Pro
A$14.99/month, A$149.99/year (#497), auto-renewing through the App Store, after a 7-day free "reverse trial"
and a 120-minute monthly free floor.

**What we ask for, by 13 November** (submission best case 16 November, likely 23 November: RELEASE.md Phase D):
1. Sign-off (or required changes) on the Terms and Privacy Policy for 1.0. §4 lists changes we already know
   1.0 needs (paid subscriptions, removing "beta").
2. A view on the recording-consent posture for the in-app recorder, and whether it is adequate for launch.
3. Answers to §3's questions, **[launch]** first. **[later]** items gate features that are off for 1.0.

## 2. Documents to send

| # | Document | Where | What to check |
|---|---|---|---|
| 1 | Terms of Service (v 2026-09-26) | `/terms` on the site · `apps/site/src/pages/terms.astro` | Eligibility (13+), recording responsibility, AI output (§6), fees (§8 still "free during the beta"), liability and ACL wording, NSW law, changes (§13), guest acceptance by use |
| 2 | Privacy Policy (v 2026-09-29) | `/privacy` · `privacy.astro` + `processing.json` | APP 1/5/8 and GDPR Art. 13, lawful bases, processors table, overseas disclosure, people you record, rights, children, retention |
| 3 | Account deletion page | `/delete-account` · `delete-account.astro` | Matches the Policy on what is deleted and the 30-day backup window |
| 4 | Notetaker explainer | `/notetaker` · `notetaker.astro` | Transparency to non-users. The page is in the repo; that it resolves on production is not verified (the 10-24 check found a 404) |
| 5 | Recording consent policy | `docs/CONSENT.md` | §2.2 notice and affirmation (§2.2 still describes the older two-step sheet; the app has one sheet); §2.4 notetaker; §4 questions |
| 6 | Data retention | `docs/DATA-RETENTION.md` | §3 what is kept; §4 the 30-day backup promise; §6 the user-facing statement |
| 7 | Store privacy declarations | `docs/STORE-COMPLIANCE.md` | §2 App Privacy answers; §4.2 permission strings; §6 deletion; §7 age rating; §8 acceptance |
| 8 | Store listing copy | `docs/STORE-LISTING.md`, and `APP-STORE-REVIEW-PACKAGE.md` §4 | Claims in the name, keywords and description |
| 9 | iOS paywall renewal text | `apps/ios/AlgoMinutes/Features/Paywall/PaywallView.swift` | Auto-renew disclosure and Terms/Privacy links (Apple 3.1.2) |
| 10 | Help improve design (not built) | `docs/plans/HELP-IMPROVE.md` | §5 sheet copy, §9 questions, §10 drafted changes |
| 11 | App Review notes | `docs/runbooks/app-store-review.md` | How the trial, free floor and consent are described to Apple |
| 12 | AI label memo | `APP-STORE-AI-LABEL.md` §5 | The AI Act and ACL questions |

Export each repo file to PDF; the live pages are the published versions.

## 3. Every `TODO(legal)` item, as questions

57 `TODO(legal)` markers in 14 files (recounted on aa7a8e38), deduplicated to 29 questions. Markers that only
point at another item (`docs/BUILD-PLAN.md`, `docs/DECISIONS.md`, `apps/android/README.md`,
`docs/audits/APP-REVIEW-2026-10-24.md`, `docs/runbooks/testflight-internal.md`) are folded in.

### 3.1 Terms and Privacy Policy

| # | Question | Current default | Cites |
|---|---|---|---|
| L1 **[launch]** | Are the Terms and Privacy Policy approved for 1.0, subject to §4's changes? Yes / with changes / no | Live, "pending legal review" | `STORE-COMPLIANCE.md`; BLOCKERS "A10 launch blockers" |
| L2 **[launch]** | Are `/terms`, `/privacy`, `/delete-account` on algominutes.algorythmos.com the final links for the listing and app? | Those URLs | `STORE-LISTING.md` |
| L3 **[launch]** | Does the APP 8 wording ("Information sent outside Australia") and our choice of providers meet APP 8.1 reasonable steps? | Discloses global Speech-to-Text, Firebase, Logging, Recall (Tokyo), Apple, Stripe | BLOCKERS "APP 8 cross-border" |
| L4 **[later]** | Must the AssemblyAI DPA be executed before AssemblyAI is enabled, and the Recall.ai DPA before the notetaker leaves the allowlist? | AssemblyAI off; Recall DPA an owner step | BLOCKERS; `docs/audits/DIARISATION-VENDOR-RETENTION.md` |

### 3.2 Retention and deletion

| # | Question | Current default | Cites |
|---|---|---|---|
| R1 **[launch]** | Is the 30-day backup-deletion window, and DATA-RETENTION §6's statement, approved? | 30 days (infra keeps 7) | `DATA-RETENTION.md`; `STORE-COMPLIANCE.md` |
| R2 **[launch]** | Is retention wording consistent across the microphone string ("kept until you delete it"), the Policy and the deletion page, given user-set auto-delete? | As in STORE-COMPLIANCE §4.2 | `STORE-COMPLIANCE.md` |
| R3 **[launch]** | Minimum retention for billing/tax records, overriding deletion for the transaction record only? 5 / 7 years / other | "As long as tax law requires"; Apple holds payment data | `DATA-RETENTION.md` |
| R4 **[launch]** | Any other legal minimum or maximum for content or logs? | User controls content; logs 30 days; usage 90 days | `DATA-RETENTION.md` |
| R5 **[launch]** | Do product events (`analytics_events`) need a time limit? | Until account deletion | `DATA-RETENTION.md` |

### 3.3 Recording consent (`docs/CONSENT.md`)

| # | Question | Current default | Cites |
|---|---|---|---|
| C1 **[launch]** | A written opinion mapping recording-consent rules per Australian state/territory and launch market, "private conversation", and whether being a party changes it? | Not commissioned; no jurisdiction logic in the app | `CONSENT.md`; BLOCKERS "A10" |
| C2 **[launch]** | Is the affirmation ("I have permission from anyone whose voice may be captured. If others are present, I'll let them know the meeting is being recorded.") adequate; should it link Terms/Privacy inline? | Mandatory tick every time the sheet opens; no inline links | `CONSENT.md`; `RecorderFlow.swift` |
| C3 **[later]** | For the notetaker bot: does a visible named participant plus a pinned chat notice amount to all-party consent under NSW law and elsewhere? | Testers only, off by default | `CONSENT.md` |
| C4 **[later]** | Must the app obtain consent from each participant, not just the user's attestation? | Attestation only | `CONSENT.md` |
| C5 **[later]** | Is a durable per-participant consent log required, and for how long? | Device-local flag only | `CONSENT.md`; `STORE-COMPLIANCE.md` |
| C6 **[later]** | Is an audible "this is being recorded" announcement required or advisable? | On-screen indicator only | `CONSENT.md` |
| C7 **[later]** | Can a participant withdraw consent, and what must happen to a mixed recording? | Owner can delete; non-users can ask | `CONSENT.md` |

### 3.4 Store compliance and listing

| # | Question | Current default | Cites |
|---|---|---|---|
| S1 **[launch]** | Are the App Privacy answers in STORE-COMPLIANCE §2 approved? | Twelve types, linked, none tracking | `STORE-COMPLIANCE.md` |
| S2 **[launch]** | Is 13+ the right age rating? 13+ / 16+ / 18+ | Provisional 13+ (an older section still argues 4+) | `STORE-COMPLIANCE.md` |
| S3 **[launch]** | Do Apple's UGC expectations apply to a private single-user app with share links off? | Share links off for 1.0 | `STORE-COMPLIANCE.md`; `docs/audits/APP-REVIEW-2026-10-24.md` |
| S4 **[launch]** | An age gate at sign-up, and at what age (Terms, rating, GDPR Art. 8, Privacy Act)? | No gate; Terms say 13+ | `STORE-COMPLIANCE.md` |
| S5 **[launch]** | Are "AI Meeting Notes" and any "record calls" keyword safe given the consent posture? | "record calls" not in the iOS keywords | `STORE-LISTING.md` |
| S6 **[later]** | Does the Android MediaProjection justification meet Play policy? | Android not in 1.0 | `STORE-COMPLIANCE.md`; Android `strings.xml` |

### 3.5 Help improve (design only, off; `docs/plans/HELP-IMPROVE.md` §9)

| # | Question | Default (design) |
|---|---|---|
| H1 **[later]** | Is per-note consent with two attestations a sufficient lawful basis (GDPR 6(1)(a), 9(2)(a); APP 6)? | Per-note opt-in, off |
| H2 **[later]** | Is the sharer's attestation enough, or limit v1 to single-speaker notes? | Attestation |
| H3 **[later]** | Users 13–17: an "I'm 18 or older" attestation, or another approach? | 18+ attestation |
| H4 **[later]** | 12 months' maximum retention, 30 days to delete on withdrawal (incl. backups)? | 12 months / 30 days |
| H5 **[later]** | Reviewer confidentiality terms; may reviewers be outside Australia? | Small named group, audit-logged |
| H6 **[later]** | Apple purpose for shared content: Analytics or Other? | Analytics |
| H7 **[later]** | Is the Terms licence in §10.2 needed, and its scope right? | Drafted, unpublished |
| H8 **[later]** | Is offering the share after a low transcript rating an undue nudge? | Offered in both places |

## 4. Risk areas to ask about

Some have no `TODO(legal)` marker; they were found while preparing this package.

1. **Recording consent across Australia and abroad.** NSW (home state, governing law) is described in our docs
   as all-party for private conversations; other states differ; the app ships everywhere but China. Is a user
   attestation plus a per-session notice an adequate floor? Does the Terms' allocation of responsibility to the
   user protect the company as a tool supplier? (C1, C2)
2. **Third-party voices.** The Policy says we process non-users' voices on the account holder's behalf. Right
   characterisation (APP entity vs processor; GDPR controller vs processor; household exemption)? Are
   transcribed and diarised voices biometric or sensitive information?
3. **GDPR / UK GDPR.** Lawful bases as stated (contract; legitimate interests). Art. 27 representative, record
   of processing, DPIA, SCCs/IDTA with Google, Recall, Stripe? "We reply within 30 days" vs the one-month rule.
4. **US state privacy laws.** Does any apply at our scale? Is "we don't sell or share" accurate? Do all-party
   states (e.g. California) change the notice for US users?
5. **Children 13–17.** No age gate, no parental flow; GDPR Art. 8 thresholds; any Australian children's code;
   whether a recording app should be 16+ or 18+ (S2, S4, H3).
6. **AI output accuracy.** Terms §6 and the Policy disclaim accuracy; the owner's default is a "written by AI"
   label (RELEASE.md status decision 5; `APP-STORE-AI-LABEL.md`). Enough under the ACL and for speaker errors?
   EU AI Act transparency?
7. **Subscriptions and the reverse trial.** **The Terms (§1 "The beta", §8 "free during the beta", the "as is
   during the beta" clause) and the Privacy Policy ("Nothing is sold during the beta") still describe a free
   beta**, while 1.0 sells auto-renewing subscriptions after a 7-day trial. Needed: subscription, trial,
   renewal, cancellation and refund terms consistent with the ACL and Apple 3.1.2; standard or custom EULA;
   whether the paywall text suffices; what happens to notes on downgrade to the free floor.
8. **Account deletion.** In-app deletion with Apple token revocation; guests too; e-mail route on the deletion
   page within 30 days; backups within 30 days (R1). Apple 5.1.1(v), APP 11.2, GDPR Art. 17, and the billing
   exception (R3).
9. **Acceptance mechanics.** Guests are bound "by using", but no acceptance is recorded until they create an
   account; a version bump records a new acceptance **silently** (BLOCKERS "A new document version is accepted
   silently"). Is browsewrap enforceable for guests; does a material change need an active re-accept?
10. **Help improve.** Reverses a published promise ("Not your recordings or notes"). H1–H8, plus disclosure of
    card-only redaction and whether existing users must re-accept.
11. **Processing region.** A Gemini location fallback exists but is off (#506; RELEASE.md status decision 1).
    If turned on, processing leaves Sydney: confirm the Policy must change first.

## 5. After sign-off

1. Record the answers in `docs/DECISIONS.md` (who signed, date, what, dated decisions for anything deferred);
   turn each answered `TODO(legal)` in CONSENT, DATA-RETENTION, STORE-COMPLIANCE and STORE-LISTING into a
   decision.
2. Edit `terms.astro`, `privacy.astro` (and `processing.json` if a processor fact changes), including §4.7's
   changes; remove the "in beta … pending legal review" banner (`apps/site/src/components/LegalNotice.astro`).
3. Bump `TERMS_VERSION` / `PRIVACY_VERSION` in `packages/contracts/src/limits.ts` and the iOS mirror
   `ComplianceContract.swift`; `tests/site-facts.test.ts` fails if they disagree.
4. Re-acceptance: each signed-in client records a new `terms_acceptance` row on next launch, without showing
   the documents. If counsel says a change is material, build the re-accept sheet first and announce it.
5. Store side: re-check App Privacy answers and age rating; set the EULA and URLs; keep the notetaker
   allowlisted until C3 is answered.
6. Proof: one docs PR, CI green including `site-facts`; then a production query showing new
   `terms_acceptance` rows with the new versions.

## Not verified

- That `/notetaker` resolves on production today.
- Which of the listed laws apply, and how: all of §3 and §4 are for counsel.
