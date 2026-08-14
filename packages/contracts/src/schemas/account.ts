// POST|DELETE /v1/delete-account — Apple App Store + GDPR account deletion
// (functions/delete-account.cjs). No request body — identity comes from the
// bearer token.
import { z } from './zod';

/** The per-step tally the handler returns. Source:
 * functions/delete-account.cjs `summary` object. */
export const DeleteAccountSummary = z
  .object({
    workspacesAffected: z.number().int(),
    notesDeleted: z.number().int(),
    notesNotFound: z.number().int(),
    pgMembershipsDeleted: z.number().int(),
    firestoreErrors: z.number().int(),
    pgErrors: z.number().int(),
    authDeleted: z.boolean(),
  })
  .openapi('DeleteAccountSummary');

/** `{ ok: true, summary }`. Source: the 200 body. */
export const DeleteAccountResponse = z
  .object({
    ok: z.literal(true),
    summary: DeleteAccountSummary,
  })
  .openapi('DeleteAccountResponse');

/** The failure body — `ErrorEnvelope` widened with the partial `summary` so a
 * client can see how far the purge got. Source: the 500 returns
 * (`auth_deletion_failed`, `unexpected_failure`). */
export const DeleteAccountError = z
  .object({
    error: z.string(),
    summary: DeleteAccountSummary.optional(),
  })
  .openapi('DeleteAccountError');

export type DeleteAccountSummary = z.infer<typeof DeleteAccountSummary>;
export type DeleteAccountResponse = z.infer<typeof DeleteAccountResponse>;
export type DeleteAccountError = z.infer<typeof DeleteAccountError>;
