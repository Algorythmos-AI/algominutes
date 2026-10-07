// Async-UX + reliability contracts (A7) and the A9 entitlement response.
// Authored ONCE here; iOS + Android (B2) + web + services/api all consume these.
// A contract change here is a three-client change — regenerate models after edit.
import { z } from './zod';

// ── A7.1 client recording lifecycle ─────────────────────────────────────────
// The per-recording state the CLIENT tracks locally (survives app kill/reboot),
// distinct from the server-side NoteStatus pipeline detail. Mapping:
//   recorded  = on disk, not yet uploaded
//   uploading = resumable upload in flight (see upload session below)
//   processing= uploaded; server pipeline running (queued→…→summarizing)
//   ready | failed = terminal
export const RecordingState = z
  .enum(['recorded', 'uploading', 'processing', 'ready', 'failed'])
  .openapi('RecordingState');

// ── A7.2 resumable upload session (shared iOS/Android contract) ──────────────
// The server creates a GCS resumable upload session; the client PUTs chunks to
// `sessionUri` via a background transfer (iOS URLSession background; Android
// WorkManager — B2), persisting the byte offset so it resumes after reboot.
export const CreateUploadSessionRequest = z
  .object({
    noteId: z.string(),
    workspaceId: z.string(),
    fileName: z.string(),
    contentType: z.string(),
    // Absent: the length isn't known yet (RELEASE.md PR 33, R3): the web recorder uploads while it records,
    // and the size cap is checked at /complete. Present: capped before a session is minted, as before.
    totalBytes: z.number().int().nonnegative().optional(),
    sha256: z.string().optional(),
  })
  .openapi('CreateUploadSessionRequest');

export const CreateUploadSessionResponse = z
  .object({
    uploadId: z.string(),
    // Opaque resumable-session URI the client uploads chunks to directly.
    sessionUri: z.string(),
    storagePath: z.string(),
    chunkSize: z.number().int().positive(), // recommended chunk size in bytes
    expiresAt: z.string(), // ISO-8601
  })
  .openapi('CreateUploadSessionResponse');

// Resume support: the client asks how many bytes the server already has.
export const UploadSessionStatus = z
  .object({
    uploadId: z.string(),
    receivedBytes: z.number().int().nonnegative(),
    complete: z.boolean(),
  })
  .openapi('UploadSessionStatus');

export const CompleteUploadResponse = z
  .object({ uploadId: z.string(), storagePath: z.string(), complete: z.literal(true) })
  .openapi('CompleteUploadResponse');

// ── A7.3 push registration + notification payload ────────────────────────────
// Suffixed `Schema` to avoid clashing with the `ClientPlatform` *type* exported
// by ./version when both are re-barrelled from ./index. `.openapi('ClientPlatform')`
// keeps the generated OpenAPI/client model name unchanged.
export const ClientPlatformSchema = z.enum(['ios', 'android', 'web']).openapi('ClientPlatform');

export const RegisterPushTokenRequest = z
  .object({
    token: z.string(), // FCM registration token / APNs via FCM
    platform: ClientPlatformSchema,
    appVersion: z.string().optional(),
  })
  .openapi('RegisterPushTokenRequest');

// The payload services/notifier sends (FCM data + notification), and the shape a
// local-notification fallback mirrors. `deepLink` opens the note (algominutes://note/<id>).
export const NotificationType = z
  .enum(['note_ready', 'note_failed'])
  .openapi('NotificationType');

export const NotificationPayload = z
  .object({
    type: NotificationType,
    noteId: z.string(),
    workspaceId: z.string(),
    title: z.string(),
    body: z.string(),
    deepLink: z.string(), // algominutes://note/<noteId>
  })
  .openapi('NotificationPayload');

/** Canonical deep link into a note (matches the iOS internal URL scheme). */
export function noteDeepLink(noteId: string): string {
  return `algominutes://note/${noteId}`;
}

// ── A9.1 entitlement response (server-resolved, never trust the client) ───────
// Suffixed `Schema` to avoid clashing with the `EntitlementState` *type* exported
// by ./limits when both are re-barrelled from ./index. `.openapi('EntitlementState')`
// keeps the generated OpenAPI/client model name unchanged.
export const EntitlementStateSchema = z
  .enum(['trialing', 'active', 'expired', 'free_floor'])
  .openapi('EntitlementState');

// Where an entitlement comes from (RELEASE.md PR 26b): a paid subscription, a grant (an invite code or a
// tester grant), the reverse trial, or the free floor. A grant reports `active` like a subscription does, so
// the clients key the purchase funnel and "Manage Subscription" off this, never off `state`.
export const EntitlementSourceSchema = z
  .enum(['subscription', 'grant', 'trial', 'free'])
  .openapi('EntitlementSource');

// The store a subscription is billed on, which is where it's managed (App Store, Stripe, Google Play).
export const SubscriptionRailSchema = z
  .enum(['apple_storekit', 'stripe', 'google_play'])
  .openapi('SubscriptionRail');

export const EntitlementResponse = z
  .object({
    state: EntitlementStateSchema, // A9.3 reverse-trial state
    plan: z.enum(['free', 'pro', 'team']),
    billingPeriod: z.string(), // YYYY-MM
    includedMinutes: z.number().nullable(), // null = per-seat/unmetered
    usedMinutes: z.number(),
    remainingMinutes: z.number().nullable(), // null when includedMinutes is null
    overQuota: z.boolean(),
    trialEndsAt: z.string().nullable().optional(), // ISO; present while trialing
    // Additive (PR 26b): optional, so a client still decodes a server from before it.
    source: EntitlementSourceSchema.optional(),
    rail: SubscriptionRailSchema.nullable().optional(), // set when source is 'subscription'
  })
  .openapi('EntitlementResponse');

// ── A7.4 dead-letter admin view ──────────────────────────────────────────────
export const DeadLetterEntry = z
  .object({
    id: z.number(),
    queue: z.string(),
    noteId: z.string().nullable(),
    workspaceId: z.string().nullable(),
    error: z.string().nullable(),
    attempts: z.number().nullable(),
    traceId: z.string().nullable(),
    /** Why, as a stable code (stt_poll_exhausted, transcode_failed, ...): migration 027. Null on older rows. */
    reason: z.string().nullable().optional(),
    createdAt: z.string(),
    resolvedAt: z.string().nullable(),
  })
  .openapi('DeadLetterEntry');

export type RecordingState = z.infer<typeof RecordingState>;
export type CreateUploadSessionRequest = z.infer<typeof CreateUploadSessionRequest>;
export type CreateUploadSessionResponse = z.infer<typeof CreateUploadSessionResponse>;
export type NotificationPayload = z.infer<typeof NotificationPayload>;
export type EntitlementResponse = z.infer<typeof EntitlementResponse>;
export type EntitlementSource = z.infer<typeof EntitlementSourceSchema>;
export type SubscriptionRail = z.infer<typeof SubscriptionRailSchema>;
export type DeadLetterEntry = z.infer<typeof DeadLetterEntry>;
