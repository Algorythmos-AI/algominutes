import { describe, it, expect } from 'vitest';
import { AppConfigResponse, FeatureDisabledError } from '@algominutes/contracts/schemas';
import { appConfig, notetakerSwitches, NOTETAKER_BUILT } from '../services/api/src/routes/app-config.js';
import { createMeetingBotRoute, cancelMeetingBotRoute } from '../services/api/src/routes/meetings.js';

// GET /v1/config: broadcast capture's kill switch. BROADCAST_CAPTURE=off
// hides the entry point; anything else, or unset, leaves it on. The body is
// the AppConfigResponse contract.
describe('app config', () => {
  it('broadcast capture is on unless the env says off', () => {
    expect(appConfig({}).broadcastCapture).toBe(true);
    expect(appConfig({ BROADCAST_CAPTURE: 'on' }).broadcastCapture).toBe(true);
    expect(appConfig({ BROADCAST_CAPTURE: 'off' }).broadcastCapture).toBe(false);
    expect(appConfig({ BROADCAST_CAPTURE: ' OFF ' }).broadcastCapture).toBe(false);
  });

  it('matches the AppConfigResponse contract', () => {
    for (const env of [{}, { BROADCAST_CAPTURE: 'off' }, { NOTETAKER: 'bot,calendar' }]) {
      expect(AppConfigResponse.parse(appConfig(env))).toEqual(appConfig(env));
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
  it('every notetaker surface is off by default', () => {
    expect(appConfig({}).notetaker).toEqual({ bot: false, calendar: false, zoomImport: false, extension: false });
  });

  it('the env alone cannot switch on a surface that is not built', () => {
    expect(NOTETAKER_BUILT.size).toBe(0);
    expect(appConfig({ NOTETAKER: 'bot,calendar,zoomImport,extension' }).notetaker).toEqual({ bot: false, calendar: false, zoomImport: false, extension: false });
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
      await route({ log: { info: (_o: unknown, m: string) => logged.push(m) } } as any, res);
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

