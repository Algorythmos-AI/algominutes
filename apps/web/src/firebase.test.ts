import { describe, expect, it } from 'vitest';
import { firebaseConfigFromEnv } from './firebase';

const ENV = {
  VITE_FIREBASE_API_KEY: 'k',
  VITE_FIREBASE_PROJECT_ID: 'algominutes-staging',
  VITE_FIREBASE_APP_ID: 'app',
  VITE_FIREBASE_MESSAGING_SENDER_ID: '1',
};

describe('firebaseConfigFromEnv', () => {
  it("uses the page's own host as authDomain (the site proxies /__/auth)", () => {
    expect(firebaseConfigFromEnv(ENV, 'staging.algominutes.algorythmos.com', false).authDomain).toBe('staging.algominutes.algorythmos.com');
  });

  it("uses the project's own domain on a dev server, which has no proxy", () => {
    expect(firebaseConfigFromEnv(ENV, 'localhost:5173', true).authDomain).toBe('algominutes-staging.firebaseapp.com');
  });

  it('refuses a build missing any value', () => {
    for (const k of Object.keys(ENV)) {
      expect(() => firebaseConfigFromEnv({ ...ENV, [k]: '' }, 'x', false), k).toThrow(new RegExp(k));
    }
  });
});
