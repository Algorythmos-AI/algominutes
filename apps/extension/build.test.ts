import { describe, it, expect } from 'vitest';
// @ts-expect-error: plain ESM build script, no type declarations
import { settingsFrom, manifestFor, parseOrigin } from './build.mjs';

const env = { EXT_API_ORIGIN: 'https://api.example.test', EXT_WEB_ORIGINS: 'https://beta.example.test, https://app.example.test', EXT_FIREBASE_API_KEY: 'test-firebase-web-key' };

describe('the build settings', () => {
  it('reads origins and the key, and refuses anything else', () => {
    expect(settingsFrom(env)).toEqual({ apiOrigin: 'https://api.example.test', webOrigins: ['https://beta.example.test', 'https://app.example.test'], firebaseApiKey: 'test-firebase-web-key' });
    expect(() => settingsFrom({ ...env, EXT_API_ORIGIN: '' })).toThrow('EXT_API_ORIGIN is not set');
    expect(() => settingsFrom({ ...env, EXT_WEB_ORIGINS: '' })).toThrow('EXT_WEB_ORIGINS is not set');
    expect(() => settingsFrom({ ...env, EXT_FIREBASE_API_KEY: 'x' })).toThrow('EXT_FIREBASE_API_KEY');
    expect(() => parseOrigin('http://api.example.test', 'X')).toThrow('https');
    expect(() => parseOrigin('https://api.example.test/v1', 'X')).toThrow('no path');
    expect(parseOrigin('http://localhost:8080', 'X')).toBe('http://localhost:8080');
  });

  it('trusts a localhost web page only in a development build', () => {
    const local = { ...env, EXT_WEB_ORIGINS: 'https://beta.example.test,http://localhost:5173' };
    expect(() => settingsFrom(local)).toThrow('only a development build (EXT_DEV=1) may trust localhost');
    expect(settingsFrom({ ...local, EXT_DEV: '1' }).webOrigins).toEqual(['https://beta.example.test', 'http://localhost:5173']);
  });
});

describe('the manifest', () => {
  const m = manifestFor(settingsFrom(env), '1.0.0');

  it('asks for nothing ADR 0002 doesn\'t list: storage, tab capture, an offscreen document, the api and Cloud Storage', () => {
    expect(m.manifest_version).toBe(3);
    expect(m.permissions).toEqual(['storage', 'tabCapture', 'offscreen']);
    expect(m.host_permissions).toEqual(['https://api.example.test/*', 'https://storage.googleapis.com/*']);
    expect(JSON.stringify(m)).not.toMatch(/<all_urls>|"tabs"|"identity"|"scripting"|content_security_policy/);
  });

  it('only the web app\'s pages may message it', () => {
    expect(m.externally_connectable).toEqual({ matches: ['https://beta.example.test/*', 'https://app.example.test/*'] });
  });

  it('is at least the api\'s floor for extensions (1.0.0), so its first build isn\'t turned away', () => {
    expect(m.version).toBe('1.0.0');
  });
});
