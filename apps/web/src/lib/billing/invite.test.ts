import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors';
import { inviteErrorMessage, inviteSuccessLine, noMinutesLeft } from './invite';

const ent = (remainingMinutes: number | null) => ({
  state: 'active' as const, plan: 'pro' as const, billingPeriod: '2026-10', includedMinutes: remainingMinutes == null ? null : 600,
  usedMinutes: 0, remainingMinutes, overQuota: remainingMinutes === 0,
});

describe('noMinutesLeft', () => {
  it('is true only when the server says none are left; unknown or unmetered never blocks', () => {
    expect(noMinutesLeft(ent(0))).toBe(true);
    expect(noMinutesLeft(ent(12))).toBe(false);
    expect(noMinutesLeft(ent(null))).toBe(false);
    expect(noMinutesLeft(null)).toBe(false);
    expect(noMinutesLeft(undefined)).toBe(false);
  });
});

describe('inviteErrorMessage', () => {
  it('says what went wrong in plain words, for each refusal', () => {
    expect(inviteErrorMessage(new ApiError('bad_request', { status: 400, code: 'invite_invalid' }))).toMatch(/isn't valid/);
    expect(inviteErrorMessage(new ApiError('bad_request', { status: 410, code: 'invite_expired' }))).toMatch(/expired/);
    expect(inviteErrorMessage(new ApiError('conflict', { status: 409, code: 'invite_used_up' }))).toMatch(/new one/);
    expect(inviteErrorMessage(new ApiError('rate_limited', { status: 429, code: 'rate_limited' }))).toMatch(/Wait/);
    expect(inviteErrorMessage(new ApiError('network'))).toMatch(/No connection/);
    expect(inviteErrorMessage(new ApiError('server', { status: 503 }))).toMatch(/our side/);
    expect(inviteErrorMessage(new Error('boom'))).toMatch(/couldn't add/);
  });
});

describe('inviteSuccessLine', () => {
  it('says how many minutes, and until when', () => {
    expect(inviteSuccessLine({ entitlement: ent(1500), grantEndsAt: '2026-10-29T00:00:00.000Z', notetaker: false }))
      .toMatch(/^You have 1,500 recording minutes, until 29 October\./);
    expect(inviteSuccessLine({ entitlement: ent(600), grantEndsAt: null, notetaker: false })).toMatch(/for this beta/);
    expect(inviteSuccessLine({ entitlement: ent(null), grantEndsAt: null, notetaker: false })).toMatch(/^Recording is on/);
  });
});
