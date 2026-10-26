import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error: plain ESM module, no type declarations
import { planFromStoreProductId, productCatalog } from '../services/billing/src/lib/plans.js';
import { PRICING } from '../packages/contracts/src/limits';

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

// The paywall shows billing's priceDisplay; the App Store charges the price set in App Store Connect (and the local
// StoreKit config mirrors it). The three must agree, and a price always shows two decimals.
describe('the catalog\'s prices', () => {
  const storekit = JSON.parse(fs.readFileSync(path.join(__dirname, '../apps/ios/StoreKit/AlgoMinutes.storekit'), 'utf8'));
  const storePrice = (id: string) =>
    Number(storekit.subscriptionGroups.flatMap((g: any) => g.subscriptions).find((s: any) => s.productID === id).displayPrice);
  const display = (id: string) => productCatalog().find((p: any) => p.id === id).priceDisplay;

  it('match the App Store prices', () => {
    expect(PRICING.proMonthly).toBe(storePrice(iosId('proMonthly')));
    expect(PRICING.proAnnual).toBe(storePrice(iosId('proAnnual')));
  });

  it('show two decimals', () => {
    expect(display('pro_monthly')).toBe(`A$${PRICING.proMonthly.toFixed(2)}`);
    expect(display('pro_annual')).toBe(`A$${PRICING.proAnnual.toFixed(2)}`);
    expect(display('pro_annual')).toMatch(/^A\$\d+\.\d{2}$/);
  });
});
