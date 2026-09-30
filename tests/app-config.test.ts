import { describe, it, expect } from 'vitest';
import { AppConfigResponse, FeatureDisabledError } from '@algominutes/contracts/schemas';
import { appConfig, notetakerSwitches, notetakerFor, NOTETAKER_BUILT } from '../services/api/src/routes/app-config.js';
import { createMeetingBotRoute, cancelMeetingBotRoute } from '../services/api/src/routes/meetings.js';

// GET /v1/config: broadcast capture's kill switch. BROADCAST_CAPTURE=off
// hides the entry point; anything else, or unset, leaves it on. The body is
// the AppConfigResponse contract.
describe('app config', () => {
  it('broadcast capture is on unless the env says off', async () => {
    expect((await appConfig({})).broadcastCapture).toBe(true);
    expect((await appConfig({ BROADCAST_CAPTURE: 'on' })).broadcastCapture).toBe(true);
    expect((await appConfig({ BROADCAST_CAPTURE: 'off' })).broadcastCapture).toBe(false);
    expect((await appConfig({ BROADCAST_CAPTURE: ' OFF ' })).broadcastCapture).toBe(false);
  });

  it('matches the AppConfigResponse contract', async () => {
    for (const env of [{}, { BROADCAST_CAPTURE: 'off' }, { NOTETAKER: 'bot,calendar' }]) {
      const body = await appConfig(env, 'alice', { isTester: async () => true });
      expect(AppConfigResponse.parse(body)).toEqual(body);
    }
  });

  it('is mounted at GET /config behind the same auth and rate limit as /entitlement', async () => {
    const { buildRouter } = await import('../services/api/src/routes/index.js');
    const stack = buildRouter().stack;
    const route = (p: string) => stack.find((l: any) => l.route && l.route.path === p)?.route;
    const config = route('/config');
    expect(config?.methods.get).toBe(true);
    const guards = (r: any) => r.stack.slice(0, -1).map((s: any) => s.handle);
    expect(guards(config).length).toBe(2);
    expect(guards(config)).toEqual(guards(route('/entitlement')));
  });

  // The online-meeting notetaker (docs/plans/MEETINGS.md): off by default, and
  // never reported on for a surface that isn't built yet.
  const OFF = { bot: false, calendar: false, zoomImport: false, extension: false };
  const testers = (...uids: string[]) => async (uid: string) => uids.includes(uid);

  it('every notetaker surface is off by default, and nothing is looked up while it is', async () => {
    let asked = 0;
    const isTester = async () => { asked += 1; return true; };
    expect((await appConfig({}, 'alice', { isTester })).notetaker).toEqual(OFF);
    expect(asked).toBe(0);
  });

  it('the env alone cannot switch on a surface that is not built, nor for someone not allowlisted', async () => {
    expect([...NOTETAKER_BUILT]).toEqual(['bot', 'extension']);
    const all = { NOTETAKER: 'bot,calendar,zoomImport,extension' };
    // No uid, or a caller who isn't a notetaker tester: nothing.
    expect((await appConfig(all, null, { isTester: testers('alice') })).notetaker).toEqual(OFF);
    expect((await appConfig(all, 'bob', { isTester: testers('alice') })).notetaker).toEqual(OFF);
    // An allowlisted tester: only what's built (the bot, and the extension's button for it), never an unbuilt surface.
    expect((await appConfig(all, 'alice', { isTester: testers('alice', 'carol') })).notetaker).toEqual({ ...OFF, bot: true, extension: true });
  });

  it('allowlisted but switched off is off; a failed lookup is off, and logged', async () => {
    expect(await notetakerFor('alice', {}, { isTester: testers('alice') })).toEqual(OFF);
    const errors: string[] = [];
    const log = { error: (_o: unknown, m: string) => errors.push(m) };
    expect(await notetakerFor('alice', { NOTETAKER: 'bot' }, { isTester: async () => { throw new Error('pg down'); }, log })).toEqual(OFF);
    expect(errors).toEqual(['notetaker_tester_lookup_failed']);
  });

  it('a built surface is on only when NOTETAKER names it', () => {
    const built = new Set(['bot', 'calendar']);
    expect(notetakerSwitches({ NOTETAKER: ' bot , extension ' }, built)).toEqual({ bot: true, calendar: false, zoomImport: false, extension: false });
    expect(notetakerSwitches({}, built)).toEqual({ bot: false, calendar: false, zoomImport: false, extension: false });
  });

  it('the notetaker routes answer 503 feature_disabled (the FeatureDisabledError contract) while it is off', async () => {
    for (const route of [createMeetingBotRoute, cancelMeetingBotRoute]) {
      const logged: string[] = [];
      let status = 0;
      let body: unknown;
      const res: any = { status: (s: number) => ((status = s), res), json: (b: unknown) => ((body = b), res) };
      await route({ uid: 'alice', log: { info: (_o: unknown, m: string) => logged.push(m) } } as any, res);
      expect(status).toBe(503);
      expect(FeatureDisabledError.parse(body)).toEqual(body);
      expect(logged).toEqual(['notetaker_disabled']);
    }
  });

  it('mounts the notetaker routes behind the same auth and rate limit as /config', async () => {
    const { buildRouter } = await import('../services/api/src/routes/index.js');
    const stack = buildRouter().stack;
    const route = (p: string) => stack.find((l: any) => l.route && l.route.path === p)?.route;
    const guards = (r: any) => r.stack.slice(0, -1).map((s: any) => s.handle);
    for (const p of ['/meetings/bots', '/meetings/bots/:botId/cancel']) {
      expect(route(p)?.methods.post, p).toBe(true);
      expect(guards(route(p)), p).toEqual(guards(route('/config')));
    }
  });
});

