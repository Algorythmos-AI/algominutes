// A10 compliance contracts: retention (#5), terms acceptance (#3), support (#4),
// and the device-attestation header for trial anti-abuse (#7).
import { z } from './zod';

// ── Retention (#5) ───────────────────────────────────────────────────────────
export const SetRetentionRequest = z
  .object({ retentionDays: z.number().int().positive().nullable() }) // null = keep until deleted
  .openapi('SetRetentionRequest');

// ── Terms/Privacy acceptance (#3) ────────────────────────────────────────────
export const AcceptTermsRequest = z
  .object({
    termsVersion: z.string(),
    privacyVersion: z.string(),
    appVersion: z.string().optional(),
    platform: z.enum(['ios', 'android', 'web']).optional(),
  })
  .openapi('AcceptTermsRequest');

// ── Support / feedback (#4) — diagnostic context ONLY, never content ──────────
export const SupportRequest = z
  .object({
    kind: z.enum(['contact', 'bad_transcript', 'bad_summary']),
    // Accepted at any length; the server keeps the first 4000 characters, so
    // a long pasted report is trimmed rather than refused.
    message: z.string().optional().openapi({ description: 'Free text. The server keeps the first 4000 characters.' }),
    noteId: z.string().optional(), // reference only — the server never attaches transcript/audio
    appVersion: z.string().optional(),
    device: z.string().optional(),
    platform: z.enum(['ios', 'android', 'web']).optional(),
  })
  .openapi('SupportRequest');

// ── Trial anti-abuse (#7) ────────────────────────────────────────────────────
// Sent on the first metered action to gate a fresh trial. Mobile carries a device
// attestation token (iOS DeviceCheck / Android Play Integrity); the server hashes
// it → trial_device_hash and refuses a second trial from the same device. Web
// carries no token — the email requirement is enforced server-side from the account.
export const DeviceAttestation = z
  .object({
    platform: z.enum(['ios', 'android', 'web']),
    // opaque attestation token (DeviceCheck / Play Integrity). Absent on web.
    attestationToken: z.string().optional(),
  })
  .openapi('DeviceAttestation');

export type SetRetentionRequest = z.infer<typeof SetRetentionRequest>;
export type AcceptTermsRequest = z.infer<typeof AcceptTermsRequest>;
export type SupportRequest = z.infer<typeof SupportRequest>;
