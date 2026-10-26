// Beta invite codes (docs/plans/RELEASE.md, PR 2): a tester enters the code from
// their invitation, and redeeming it gives them a time-limited Pro grant, plus
// the notetaker when the invite includes it.
import { z } from './zod';
import { IsoDateTime } from './common';
import { EntitlementResponse } from './async';

export const RedeemInviteRequest = z
  .object({
    // What the tester typed or pasted. Case, spaces and dashes don't matter.
    code: z.string().min(1).max(64).openapi({ example: 'BETA-7K2QX-M9D4R-TW8HN' }),
  })
  .openapi('RedeemInviteRequest');

export const RedeemInviteResponse = z
  .object({
    entitlement: EntitlementResponse,
    // When the beta minutes end; null = until revoked.
    grantEndsAt: IsoDateTime.nullable(),
    // Whether this invite also allows sending the notetaker.
    notetaker: z.boolean(),
  })
  .openapi('RedeemInviteResponse');

// The refusals. `invite_invalid` also covers a revoked code, so a guess learns nothing.
export const RedeemInviteError = z
  .object({ error: z.enum(['invite_invalid', 'invite_expired', 'invite_used_up']) })
  .openapi('RedeemInviteError');

export type RedeemInviteRequest = z.infer<typeof RedeemInviteRequest>;
export type RedeemInviteResponse = z.infer<typeof RedeemInviteResponse>;
export type RedeemInviteError = z.infer<typeof RedeemInviteError>;
