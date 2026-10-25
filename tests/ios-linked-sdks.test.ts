import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// The App Privacy answers and the privacy manifest say AlgoMinutes has no analytics or advertising SDK (plan rev 12,
// I8). Package resolution pulls GoogleAppMeasurement and Google's ads-conversion SDK into Package.resolved, as part
// of firebase-ios-sdk's graph, but they're only linked if a product the app depends on needs them: the
// products below don't. A new product needs a look first, and this test makes it one. (The archive's own check,
// `otool -L`, is Stage 3's proof.)
const yml = readFileSync('apps/ios/project.yml', 'utf8');
const products = [...yml.matchAll(/^\s*product:\s*(\S+)\s*$/gm)].map((m) => m[1]).sort();

describe('the SDKs the iPhone app links', () => {
  it('are exactly the reviewed ones', () => {
    expect(products).toEqual(['FirebaseAuth', 'FirebaseCrashlytics', 'FirebaseFirestore', 'FirebaseMessaging', 'GoogleSignIn', 'GoogleSignInSwift']);
  });

  it('include nothing for analytics or advertising', () => {
    for (const p of products) expect(p).not.toMatch(/Analytics|AppMeasurement|Ads|AdServices|Performance|RemoteConfig|InAppMessaging/i);
  });
});
