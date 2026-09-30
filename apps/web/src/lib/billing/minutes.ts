/** When a month's minutes renew: the first of the next month (UTC), from the entitlement's `YYYY-MM`. */
export function resetDate(period: string, locale = 'en-AU'): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return null;
  const next = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
  return next.toLocaleDateString(locale, { day: 'numeric', month: 'long', timeZone: 'UTC' });
}
