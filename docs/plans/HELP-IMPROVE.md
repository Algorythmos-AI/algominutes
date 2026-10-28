# Help improve AlgoMinutes: sharing one note, by choice (design, for legal review)

**Status: design only. Nothing here is built or published.** The owner asked for it on 2026-10-28: an opt-in,
off by default, one note at a time, with the Privacy Policy and App Privacy changes drafted for legal review
before anything ships. The published documents promise the opposite today ("We don't use your recordings or
notes to train AI models"; product improvement uses "product events and the feedback you send us. Not your
recordings or notes."), so nothing here may run until §10's documents are approved, published and accepted.

## 1. What it is, and what it isn't

A person can choose to share **one note** with the AlgoMinutes team, so we can see where transcription or a
summary went wrong and measure whether a change makes it better. Every share is a separate, deliberate choice,
and it can be withdrawn at any time.

It is **not**:

- on by default, on for all notes, or a condition of using any feature (declining changes nothing);
- training of any AI model, ours or a provider's (v1 is human review and evaluation only, §4);
- shared with anyone outside the AlgoMinutes team, sold, or used for advertising or marketing;
- audio (v1 shares text only, §3);
- available for notes made by the meeting notetaker, or by a guest (§2).

## 2. Who can share

| Who | v1 | Why |
|---|---|---|
| A signed-in account holder | Yes | Withdrawal and deletion need an account that lasts |
| A guest | No | A guest who signs out can never reach the note again, so they couldn't withdraw it |
| A note from the meeting notetaker | No | The people in that meeting agreed to a notetaker, not to the AlgoMinutes team reading it |
| A note shared into someone else's workspace | Only its author | One person can't consent for another's note |
| Someone under 18 | `TODO(legal)` | The age rating is 13+. Recommended: an "I'm 18 or older" attestation in the sheet (§5) |

## 3. What is shared (v1)

A **snapshot taken when the person shares**, not a live link to the note:

- the transcript, after `redactPII` (the same scrub as before Gemini: card numbers and similar identifiers become
  `<<REDACTED:…>>` tags), with the speaker names the person added replaced by "Speaker 1, 2, …";
- the summary, action items, decisions and chapters as generated, plus the title (after the same scrub);
- the recording's length, language, note type, and the model and pipeline versions that made it;
- the person's rating and comment, if they add one in the sheet.

**Not shared:** the audio, the person's name or email, other notes, search or chat questions, or anything from the
device. The snapshot is linked to the account only through the consent record (§7), so it can be withdrawn and
deleted; the reviewers see a random contribution id, not who sent it.

Audio (optional, a second tick) is a possible v2, after this has run and legal has looked at voices as biometric
or sensitive data. It isn't in this design.

## 4. What we do with it

- **Human review** by a small, named group of the AlgoMinutes team (§7), to find transcription, redaction and
  summary faults.
- **An evaluation set:** when a prompt, model or pipeline change is proposed, its output on these notes is
  compared with the current one. The notes are inputs to a test, never training data.
- **Aggregate measures** (for example "summaries missing an action item: 4% of shared notes") that contain no
  note content.

Never: training or fine-tuning any model; sending a shared note to any AI provider except to re-run our own
pipeline on it for an evaluation (the same processors and region as the product, Privacy Policy §processors);
quoting a note's content outside the reviewing group.

## 5. The experience (iPhone, then web)

**Where it's offered.** In a note's **More operations › Help improve AlgoMinutes**. Also, and only then, from the
transcript rating card after a low rating ("Want to share this note so we can see what went wrong?"). That is
the one contextual prompt: no launch prompts, banners, badges or repeated asks. `TODO(legal)`: confirm the
rating-card entry isn't an undue nudge.

**The sheet** (draft copy, for legal review):

> **Help improve AlgoMinutes**
>
> Share this note's transcript and summary with the AlgoMinutes team. A few people on our team will read it to
> find mistakes and check that changes make AlgoMinutes better. We won't use it to train AI models, and we won't
> share it outside our team.
>
> What's shared: the transcript and summary, with card numbers and similar details removed and speaker names
> replaced. Not the audio, and not your name or email.
>
> You can stop sharing at any time in this note or in Settings › Privacy, and we'll delete our copy within 30 days.
> Deleting the note or your account deletes it too.
>
> ☐ Everyone whose words are in this note agreed to it being shared for this.
> ☐ I'm 18 or older.
>
> [Share this note] [Not now]

**Share this note** is enabled only with both boxes ticked. **Not now** is as prominent as Share, and dismissing
the sheet records nothing.

**After sharing.** The note shows "Shared to help improve AlgoMinutes · Stop sharing". **Settings › Privacy ›
Notes you've shared** lists them, each with Stop sharing. Stop sharing asks once ("We'll delete our copy within
30 days") and then removes it from the list at once.

## 6. Kill switch and rollout

A server switch, `improvement_sharing` (AppSwitches, like `broadcast_capture`), **off** in every environment by
default. The entry point and the endpoints both check it. Off, nothing is offered and the endpoints answer 403
`feature_off`. Withdrawal always works, switch or no switch.

## 7. Data handling

- **Where:** a separate Postgres schema, `improvement`, in the same Cloud SQL instance (australia-southeast1).
  Table `improvement.contributions` (contribution id, snapshot, created at, withdrawn at), and
  `improvement.consents` (contribution id, note id, workspace id, uid, consent-text version, privacy version,
  app version, both attestations, consented at, withdrawn at). Product services read neither.
- **Access:** a database role and an IAM group of named reviewers; Data Access audit logs on; no exports, no
  copies to laptops; review happens in an internal admin view that shows the snapshot and its contribution id
  only.
- **Retention:** 12 months from sharing at most, then deleted by the sweeper (`db-job`), which logs it.
- **Withdrawal:** marked at once (no longer shown to reviewers), deleted within 30 days, including backups, on
  the same terms as `docs/DATA-RETENTION.md`.
- **Note or account deletion:** deletes the contribution in the same transaction as the note (a cascade from
  `notes`), and account deletion deletes all of the account's.
- **Idempotent:** sharing twice is one contribution (an upsert on note id); a replayed withdrawal is a no-op.
- **Logged:** `improvement_shared`, `improvement_withdrawn` and `improvement_deleted`, with traceId, userId,
  noteId and workspaceId, and never content.

## 8. Contract and server (when built)

A three-client change in `@algominutes/contracts`, versioned:

- `POST /v1/notes/{id}/improvement` (body: the two attestations, consent-text version) → 201 with the
  contribution id; refused for a guest, a notetaker note, a note not authored by the caller, or with the switch
  off.
- `DELETE /v1/notes/{id}/improvement` → 204 (withdraw).
- `GET /v1/improvement` → the caller's shared notes.

Every query filtered by workspace membership. The snapshot is made server-side from Postgres, never sent by the
client, and scrubbed with `redactPII` before it's stored (`pii-scrub-compliance` applies).

## 9. Questions for legal (`TODO(legal)`)

1. **Lawful basis.** Consent (GDPR Art. 6(1)(a)); explicit consent where a note holds special-category data,
   such as health in a meeting (Art. 9(2)(a)). Australian Privacy Act APP 6: a secondary purpose with consent.
   Is per-note consent with the two attestations sufficient?
2. **Other people's words.** Is the person's attestation that everyone agreed enough, or should v1 be limited
   to notes with one speaker?
3. **Age.** The 18+ attestation, or another approach for 13–17 (the age rating is 13+).
4. **Retention.** 12 months, and 30 days for withdrawal (including backups).
5. **Reviewer access.** Confidentiality terms for reviewers; whether reviewers outside Australia are allowed.
6. **Apple's purpose.** "Analytics" or "Other Purposes" for the shared content (§10.3).
7. **Terms.** Whether the licence in §10.2 is needed, and its scope.
8. **The rating-card prompt** (§5): acceptable, or only the More operations entry.

## 10. Drafts of the document changes (not published; for legal review)

### 10.1 Privacy Policy (`apps/site/src/pages/privacy.astro`)

*Short version.* Replace "We don't use your recordings or notes to train AI models." with:

> We don't use your recordings or notes to train AI models. If you choose to share a note to help improve
> AlgoMinutes, a few people on our team can read that note's transcript and summary; you can stop at any time.

*How we use it.* Replace "To improve AlgoMinutes, using product events and the feedback you send us. Not your
recordings or notes." with:

> To improve AlgoMinutes, using product events, the feedback you send us, and notes you choose to share with us
> (see [Help improve AlgoMinutes](#improve)). Not your other recordings or notes.

*Lawful basis paragraph.* Add: "For notes you choose to share, we rely on your consent, which you can withdraw at
any time."

*New section* (after AI processing):

> ### Help improve AlgoMinutes {#improve}
>
> You can choose to share a note with us, one note at a time. It's off unless you turn it on for that note, and
> not sharing changes nothing about what AlgoMinutes does for you.
>
> **What we receive:** that note's transcript and summary as they were when you shared it, with card numbers and
> similar identifiers removed and the speaker names you added replaced. Not the audio, and not your name or
> email.
>
> **What we do with it:** a few people on the AlgoMinutes team read it to find mistakes, and we use it to check
> that changes to AlgoMinutes make results better. We don't use it to train AI models, and we don't share it
> outside our team or sell it.
>
> **Your choices:** you can stop sharing a note at any time, in the note or in Settings › Privacy. We stop
> using it at once and delete our copy within 30 days. Deleting the note or your account deletes it too. We keep
> a shared note for at most 12 months.
>
> **Other people:** only share a note if everyone whose words are in it agreed. Guests and notes made by the
> meeting notetaker can't be shared.

*Processors table.* No change: the same processors and region.

*Version.* `PRIVACY_VERSION` is bumped when published, so every client records a new acceptance.

### 10.2 Terms (`apps/site/src/pages/terms.astro`), if legal wants a licence

> If you choose to share a note to help improve AlgoMinutes, you give us permission to keep and use that note,
> as the Privacy Policy describes, until you stop sharing it or delete it. You confirm you have the agreement of
> everyone whose words are in it.

`TERMS_VERSION` bumped with it.

### 10.3 App Store Connect App Privacy (`docs/STORE-COMPLIANCE.md` §2)

| Data type | Today | With sharing |
|---|---|---|
| Other User Content | App Functionality | App Functionality, **Analytics** (`TODO(legal)`: or Other Purposes) |
| Audio Data | App Functionality | Unchanged (v1 shares no audio) |
| Customer Support | App Functionality | Unchanged (the optional comment in the sheet is part of the shared note) |

Linked to the user: yes (unchanged). Tracking: no (unchanged). Apple asks for every purpose data is collected
for, opt-in or not, so the label changes when the feature ships, whether or not anyone shares.

### 10.4 The privacy manifests (`PrivacyInfo.xcprivacy`)

`NSPrivacyCollectedDataTypeOtherUserContent` gains `NSPrivacyCollectedDataTypePurposeAnalytics` (or `…Other`,
per §9.6). `tests/app-privacy-answers.test.ts` holds §10.3 and the manifest together, so both change in the
same PR as the feature.

### 10.5 Google Play Data Safety (`docs/STORE-COMPLIANCE.md` §3)

"Other in-app messages / Other user-generated content": add the purpose "Analytics", marked **optional** (the
user can choose whether it's collected).

## 11. Order of work, once legal has answered

1. Legal's answers recorded in `docs/DECISIONS.md`; this design updated to match.
2. `docs`: the published Privacy Policy and Terms changes, with `PRIVACY_VERSION`/`TERMS_VERSION` bumps, and
   `STORE-COMPLIANCE.md`, `DATA-RETENTION.md` and the manifests (one PR, with the test).
3. `feat(db)`: the `improvement` schema (a new migration, expand only), the repo functions, and the sweeper's
   retention and withdrawal jobs.
4. `feat(api,contracts)`: the endpoints behind the switch, with two-account tenancy tests and replay tests.
5. `feat(ios)`: the sheet, the note's state and Settings › Privacy, behind the switch. Device tests: share,
   withdraw, delete the note, delete the account, each followed by a database check that the snapshot is gone.
6. `feat(web)`: the same on the web.
7. App Store submission with the new labels; the switch turned on in production only after that build is live.

## 12. Risks

- **Content is confidential.** Meetings hold business secrets and other people's personal information: hence
  text only, a small named group, audit logs, 12 months at most, and no copies.
- **Redaction is partial.** `redactPII` removes card numbers and similar identifiers, not names or companies in
  what was said. The sheet says so ("card numbers and similar details removed"), and reviewers are bound by §9.5.
- **Expectations.** People have been told their notes are never used for this. The change is announced in the
  updated Privacy Policy, every client records a new acceptance, and nothing changes for anyone who doesn't
  share.
