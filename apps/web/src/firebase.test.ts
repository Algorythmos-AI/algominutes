import { describe, expect, it } from 'vitest';
import { firebaseConfigFromEnv } from './firebase';

const ENV = {
  VITE_FIREBASE_API_KEY: 'k',
  VITE_FIREBASE_PROJECT_ID: 'algominutes-staging',
  VITE_FIREBASE_APP_ID: 'app',
  VITE_FIREBASE_MESSAGING_SENDER_ID: '1',
};

describe('firebaseConfigFromEnv', () => {
  it("uses the environment's site host as authDomain (the site proxies /__/auth there)", () => {
    expect(firebaseConfigFromEnv({ ...ENV, VITE_FIREBASE_AUTH_DOMAIN: 'staging.algominutes.algorythmos.com' }, false).authDomain).toBe('staging.algominutes.algorythmos.com');
  });

  it("falls back to the project's own domain without one, and always on a dev server", () => {
    expect(firebaseConfigFromEnv(ENV, false).authDomain).toBe('algominutes-staging.firebaseapp.com');
    expect(firebaseConfigFromEnv({ ...ENV, VITE_FIREBASE_AUTH_DOMAIN: 'staging.algominutes.algorythmos.com' }, true).authDomain).toBe('algominutes-staging.firebaseapp.com');
  });

  it('refuses a build missing any required value', () => {
    for (const k of Object.keys(ENV)) {
      expect(() => firebaseConfigFromEnv({ ...ENV, [k]: '' }, false), k).toThrow(new RegExp(k));
    }
  });
});
