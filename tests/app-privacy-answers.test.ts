import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// App Review compares the App Privacy answers with what the app does, and Xcode's Privacy Report aggregates the
// privacy manifests: the drafted answers (docs/STORE-COMPLIANCE.md §2) contradicted the app's own manifest (plan
// rev 12's audit: "Usage Data / Analytics: No" against a declared Product Interaction for Analytics; Name and
// Customer Support missing). Here the §2 table and PrivacyInfo.xcprivacy must be the same, row for row.
const manifest = readFileSync('apps/ios/AlgoMinutes/PrivacyInfo.xcprivacy', 'utf8');
const extension = readFileSync('apps/ios/BroadcastExtension/PrivacyInfo.xcprivacy', 'utf8');
const doc = readFileSync('docs/STORE-COMPLIANCE.md', 'utf8');

type Declared = { linked: boolean; tracking: boolean; purposes: string[] };

/** The collected data types of a privacy manifest, by name (NSPrivacyCollectedDataType<Name>). */
function collected(plist: string): Record<string, Declared> {
  const out: Record<string, Declared> = {};
  const block = /<key>NSPrivacyCollectedDataTypes<\/key>\s*<array>([^]*?)\n\t<\/array>/.exec(plist)?.[1] ?? '';
  for (const d of block.split('<dict>').slice(1)) {
    const name = /<string>NSPrivacyCollectedDataType(\w+)<\/string>/.exec(d)![1];
    out[name] = {
      linked: /<key>NSPrivacyCollectedDataTypeLinked<\/key>\s*<true\/>/.test(d),
      tracking: /<key>NSPrivacyCollectedDataTypeTracking<\/key>\s*<true\/>/.test(d),
      purposes: [...d.matchAll(/<string>NSPrivacyCollectedDataTypePurpose(\w+)<\/string>/g)].map((m) => m[1]).sort(),
    };
  }
  return out;
}

// Apple's names for them, as App Store Connect shows them.
const LABEL: Record<string, string> = {
  Name: 'Name', EmailAddress: 'Email Address', UserID: 'User ID', DeviceID: 'Device ID',
  PurchaseHistory: 'Purchase History', ProductInteraction: 'Product Interaction', AudioData: 'Audio Data',
  OtherUserContent: 'Other User Content', CustomerSupport: 'Customer Support', CrashData: 'Crash Data',
  PerformanceData: 'Performance Data', OtherDiagnosticData: 'Other Diagnostic Data',
};
const PURPOSE: Record<string, string> = { AppFunctionality: 'App Functionality', Analytics: 'Analytics' };

/** §2's table: the rows App Store Connect is answered from. */
function answers(): Record<string, { purposes: string[]; linked: string; tracking: string }> {
  const section = doc.slice(doc.indexOf('## 2. '), doc.indexOf('## 3. '));
  const rows: Record<string, { purposes: string[]; linked: string; tracking: string }> = {};
  for (const line of section.split('\n')) {
    const cells = line.split('|').slice(1, -1).map((c) => c.replace(/\*\*/g, '').trim());
    if (cells.length < 6 || cells[0] === 'Data type' || /^-+$/.test(cells[0])) continue;
    rows[cells[0]] = { purposes: cells[2].split(',').map((p) => p.trim()).sort(), linked: cells[3], tracking: cells[4] };
  }
  return rows;
}

describe('the App Privacy answers are the privacy manifest', () => {
  const declared = collected(manifest);

  it('declare no tracking anywhere', () => {
    for (const plist of [manifest, extension]) {
      expect(plist).toMatch(/<key>NSPrivacyTracking<\/key>\s*<false\/>/);
      expect(plist).toMatch(/<key>NSPrivacyTrackingDomains<\/key>\s*<array\/>/);
    }
    for (const [name, d] of Object.entries(declared)) expect(d.tracking, name).toBe(false);
  });

  it('answer for exactly the data types the manifest declares', () => {
    expect(Object.keys(declared).every((k) => k in LABEL), `a type with no label: ${Object.keys(declared)}`).toBe(true);
    expect(Object.keys(answers()).sort()).toEqual(Object.keys(declared).map((k) => LABEL[k]).sort());
  });

  it("give each the manifest's purposes, linked, and never tracking", () => {
    const rows = answers();
    for (const [name, d] of Object.entries(declared)) {
      const row = rows[LABEL[name]];
      expect(row.purposes, name).toEqual(d.purposes.map((p) => PURPOSE[p]).sort());
      expect(row.linked, name).toBe(d.linked ? 'Yes' : 'No');
      expect(row.tracking, name).toBe('No');
    }
  });

  // The app's own funnel events (/v1/events) are Product Interaction, for Analytics: there is no analytics SDK,
  // but "analytics: none" would be untrue.
  it('own the app’s first-party analytics', () => {
    expect(declared.ProductInteraction?.purposes).toEqual(['Analytics']);
    expect(doc).not.toMatch(/analytics \/ tracking = NONE/);
  });

  // MetricKit's hangs, CPU and disk reports reach Crashlytics (MetricKitReporter): Performance Data.
  it('declare what Crashlytics and MetricKit send', () => {
    for (const t of ['CrashData', 'PerformanceData', 'OtherDiagnosticData']) expect(declared[t], t).toBeDefined();
  });

  it("the broadcast extension declares nothing the app doesn't", () => {
    for (const t of Object.keys(collected(extension))) expect(declared[t], t).toBeDefined();
  });
});
