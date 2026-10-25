import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error: plain ESM module, no type declarations
import { planFromStoreProductId } from '../services/billing/src/lib/plans.js';

// The iPhone sells the product ids in Entitlement.swift (the ones created in App Store Connect). The billing
// service must recognise them with no env set, or every purchase logs `unknown_store_product` and is recorded
// without its period. Read from the Swift source, so a renamed product fails here, not in a sandbox purchase.
const swift = fs.readFileSync(path.join(__dirname, '../apps/ios/AlgoMinutes/Models/Entitlement.swift'), 'utf8');
const iosId = (name: string) => {
  const m = swift.match(new RegExp(`static let ${name} = "([^"]+)"`));
  if (!m) throw new Error(`StoreProductID.${name} not found in Entitlement.swift`);
  return m[1];
};

describe('planFromStoreProductId', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.APPLE_PRODUCT_PRO_MONTHLY;
    delete process.env.APPLE_PRODUCT_PRO_ANNUAL;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("knows the iPhone's monthly and annual products with no env set", () => {
    expect(planFromStoreProductId(iosId('proMonthly'))).toEqual({ plan: 'pro', period: 'monthly', known: true });
    expect(planFromStoreProductId(iosId('proAnnual'))).toEqual({ plan: 'pro', period: 'annual', known: true });
  });

  it('still lets the env override the Apple product ids', () => {
    process.env.APPLE_PRODUCT_PRO_MONTHLY = 'com.example.other.monthly';
    expect(planFromStoreProductId('com.example.other.monthly')).toEqual({ plan: 'pro', period: 'monthly', known: true });
    expect(planFromStoreProductId(iosId('proMonthly')).known).toBe(false);
  });

  it('flags an unknown product, still as Pro', () => {
    expect(planFromStoreProductId('com.example.unknown')).toEqual({ plan: 'pro', period: null, known: false });
  });
});
