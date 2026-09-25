# DATA-RETENTION — Retention & Deletion Policy (A10 #5)

> Launch-blocker artifact. Publisher: **Algorythmos Pty Ltd** (Sydney, AU). Defines what
> AlgoMinutes keeps, where, for how long, and how deletion propagates — including into
> backups. Must stay consistent with `docs/STORE-COMPLIANCE.md` (store declarations,
> deletion page) and `docs/CONSENT.md`. Data model: **Postgres = source of truth,
> Firestore = cache, audio in Cloud Storage.**

---

## 1. Principles

- **User-controlled by default.** Data is kept until the user deletes it (a note, or their
  account), subject to the user-set retention options in §2.
- **Deletion is real and propagates**, including into backups within a **stated window**
  (§4). "Deleted" never silently means "still in a backup forever".
- **Minimise on the device.** Local audio exists only long enough to guarantee a
  successful upload, then is purged (§5).
- **No analytics store.** Firebase Analytics is off (A6.9); there is no separate behavioural
  data warehouse to retain or expire.

---

## 2. User-set retention options

Users choose how long recordings/derived data are kept before automatic deletion. Proposed
options (product-configurable, plan-aware):

- **Keep until I delete** (default) — nothing auto-expires; user deletes notes/account
  manually.
- **Auto-delete after 30 / 90 / 365 days** — per-note age triggers the same deletion path
  as a manual delete (§3).
- **Auto-delete original audio after transcription** — keep transcript + summary, drop the
  source audio early (privacy-forward option).
- **Scope:** a workspace-level default plus per-note override.
- **Enforced** by the `db-sweep` job (Cloud Scheduler, every 15 min; `services/db-job/src/handlers/sweep.js`,
  step `retention`). It selects notes older than their author's `users.retention_days`, deletes each through
  notes-repo `deleteNote` (the manual-delete path: Postgres first, then the Firestore mirror, then the
  audio purge, retried by the sweep until it succeeds), and logs `note_deleted_retention`. Today the setting
  is per user (`POST /v1/account/retention`); the workspace default and per-note override are not built.
  "Auto-delete original audio after transcription" is not built either.
- `TODO(legal):` Whether any minimum or maximum retention is legally mandated (e.g. if the
  consent-log in CONSENT §4.3 becomes required, it may have its own retention rule).

---

## 3. What is kept, where, and for how long

| Data | Store | Kept for | Deleted by |
|---|---|---|---|
| **Original audio** | Cloud Storage (GCS), note-prefixed | Until note/account delete or user-set retention; local device copy purged after confirmed upload (§5) | `POST /v1/notes/delete` → a `storage_purges` row in the delete's transaction, purged right away and retried until it succeeds |
| **Intermediate FLAC chunks** | Cloud Storage (processing scratch) | Transient — through processing; backstopped by the delete cascade | the transcoder, then the note's `storage_purges` row (`transcoder/{noteId}/`) |
| **Transcript lines** | Postgres `transcript_lines` (+ Firestore cache) | With the note | `DELETE FROM notes` → `ON DELETE CASCADE` |
| **Summaries / action items / key decisions** | Postgres `summaries`, `action_items`, `key_decisions` | With the note | `ON DELETE CASCADE` |
| **Embeddings** | Postgres `embeddings` | With the note | `ON DELETE CASCADE` |
| **Audio chunk metadata** | Postgres `audio_chunks` | With the note | `ON DELETE CASCADE` |
| **Note record** | Postgres `notes` (+ Firestore `workspaces/{ws}/notes/{id}`) | Until deleted | `POST /v1/notes/delete` (notes-repo `deleteNote`: Postgres first, then the Firestore mirror) / delete-account / retention job |
| **Account: email + uid** | Firebase Auth + Postgres `users` | Until account deletion | `POST /v1/account/delete`: Postgres first (the `users` cascade), then open upload sessions cancelled, each note's doc + audio (`storage_purges`), the account's workspace docs (with subcollections) + storage, and Auth last. 200 only when all of it is gone; idempotent, so a retry finishes it |
| **Deleted-account tombstone** | Postgres `account_deletions` (uid, its workspace ids; no content) | Kept so a still-valid token can't re-create the account, and a retry (or the sweeper) can finish | The sweeper (`db-job` `sweep`, every 15 min) prunes completed rows after 30 days |
| **Workspace membership** | Postgres `workspace_members` | Until account deletion / removal | `delete-account` endpoint |
| **Push token (FCM)** | Server-side token store | Until token rotates or account deletion | rotation / account delete |
| **Billing/subscription state** | Stripe / App Store / Play + Postgres | Per payment-processor + tax/record-keeping law | see below |
| **Server logs** (traceId, uid, noteId, workspaceId, error events) | Cloud Logging | **Log retention window** — recommend **30 days** operational, then purge | Logging retention config |
| **Backups** | Postgres automated backups / PITR; Storage object versioning if enabled | **Backup retention window** — see §4 | lifecycle expiry |

- `TODO(legal):` Billing/tax records may have a **legally required minimum** retention
  (AU tax/financial-record rules commonly ~5–7 years) that **overrides** user deletion for
  the financial record only (not the recordings/transcripts). Confirm the exact obligation
  and word it so users understand their *content* is deleted even though a minimal
  transaction record is retained for tax.

---

## 4. Deletion propagation into backups — the stated window

**Stated window: a user's deleted data (recordings, transcripts, and derived content) is
removed from all systems, including backups, within 30 days of deletion.**

Why 30 days:
- It comfortably exceeds any realistic backup/PITR rotation, so a deleted item cannot
  survive in a backup longer than the window.
- It is a widely recognised, defensible commitment for consumer apps and aligns with common
  GDPR/right-to-erasure practice ("without undue delay", operationalised as ≤30 days).
- It lets us set the **Postgres backup / PITR retention to ≤ 30 days** and Storage object
  versioning/lifecycle to ≤ 30 days, so expiry *automatically* satisfies the promise
  without a bespoke "reach into a backup and surgically delete" mechanism (which is
  impractical for point-in-time backups).

Mechanics:
- **Live data** (Postgres rows, Firestore docs, Storage objects, local device copy) is
  deleted **immediately** on the user action (§3 / §5).
- **Backups** are not edited in place; instead, backup retention is **capped at the window**
  so any backup still containing the deleted item ages out within 30 days and is destroyed.
- `TODO(A11):` **Infra config** to make the promise true and testable:
  - Postgres automated-backup / PITR retention set to **≤ 30 days** (Cloud SQL backup +
    transaction-log retention).
  - Cloud Storage bucket **lifecycle rule** (and, if object versioning is enabled, a
    noncurrent-version expiry) set to **≤ 30 days** so soft-deleted/older versions expire.
  - Cloud Logging retention set to the §3 log window (recommend 30 days).
  - A documented verification (query/log) proving no backup older than the window is
    retained. Per CLAUDE.md, closure needs evidence, not a config screenshot.

---

## 5. Local-storage purge policy (device-side audio)

Reference: iOS `apps/ios/AlgoMinutes/Services/RecordingStore.swift`.

- Recordings are written to the app's own directory (Application Support, not
  `temporaryDirectory` which iOS can purge under pressure) with a JSON **sidecar** carrying
  the note id + upload metadata, written **before** the upload begins so an interrupted
  upload survives an app kill and is retried.
- **Upload lifecycle states:** `recorded → uploading → processing → ready / failed`.
- **Purge rule:**
  - **On confirmed upload** → `RecordingStore.remove(...)` deletes the audio file **and**
    its sidecar. This is the normal, immediate device-side purge.
  - **On upload failure / app kill** → audio + sidecar **remain** and are recovered/retried
    on next launch (durable upload lifecycle, A7.x). They are only purged once upload is
    confirmed.
- **Net effect:** the device holds audio **only** as long as needed to guarantee it reached
  Cloud Storage. There is no long-lived local audio cache.
- **Android:** apply the same "purge-after-confirmed-upload" rule in the Android recorder
  (`RecordingService` / upload path). `TODO(eng):` confirm parity with the iOS lifecycle
  (Android recorder consent/flow is B2 — see BLOCKERS).
- **On account deletion:** any remaining pending recordings are removed locally so no audio
  is stranded on-device after the server-side purge.

---

## 6. What we tell the user (plain-English statement for the Privacy Policy / deletion page)

> "Your recordings and their transcripts and summaries are stored in your AlgoMinutes
> account. On your device, a recording is kept only until it has finished uploading, then
> it's deleted from the device. You can delete any note at any time, or set recordings to
> delete automatically. When you delete a note or your whole account, we delete the audio,
> transcript, summary, and related data from our live systems straight away, and from our
> backups within 30 days. We do not use analytics or tracking. A minimal billing record may
> be kept where the law requires it."

- `TODO(legal):` Confirm this statement and the 30-day figure before it ships on the
  Privacy Policy and the Play deletion page (`docs/STORE-COMPLIANCE.md` §6.2).

---

## 7. Open-items summary

| Item | Type |
|---|---|
| Backup/PITR retention ≤ 30 days (Cloud SQL) (§4) | `TODO(A11)` — **blocking the promise** |
| Storage lifecycle/version expiry ≤ 30 days (§4) | `TODO(A11)` — blocking the promise |
| Cloud Logging retention config (§3, §4) | `TODO(A11)` |
| Auto-delete enforcer job for user-set retention (§2) | Done: `db-sweep` step `retention` (§2) |
| Verification evidence that no backup outlives the window (§4) | `TODO(A11)` |
| Billing/tax minimum-retention obligation (§3) | `TODO(legal)` |
| Legally mandated min/max retention, incl. consent log (§2) | `TODO(legal)` |
| Confirm the 30-day figure + user-facing statement (§6) | `TODO(legal)` |
| Android device-purge parity (§5) | Eng (B2) |
