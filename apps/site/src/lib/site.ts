// The site's shared facts: the document versions come from @algominutes/contracts
// (the apps record the version the user accepted), the operator from processing.json.
import { PRIVACY_VERSION, RETENTION_OPTIONS_DAYS, TERMS_VERSION } from '@algominutes/contracts';
import processing from '../data/processing.json';

export { PRIVACY_VERSION, TERMS_VERSION, RETENTION_OPTIONS_DAYS };
export const operator = processing.operator;
export const processors = processing.processors;
export const facts = {
  primaryRegionLabel: processing.primaryRegionLabel,
  backupWindowDays: processing.backupWindowDays,
  logRetentionDays: processing.logRetentionDays,
};

/** 2026-09-26 → "26 September 2026" (the legal pages' "last updated" line). */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1];
  return `${d} ${month} ${y}`;
}

/** "30, 90, 180 or 365 days". */
export function retentionChoices(): string {
  const days = [...RETENTION_OPTIONS_DAYS];
  return `${days.slice(0, -1).join(', ')} or ${days[days.length - 1]} days`;
}

export const nav = [
  { href: '/support', label: 'Support' },
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
];
