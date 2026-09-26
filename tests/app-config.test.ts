import { describe, it, expect } from 'vitest';
import { AppConfigResponse } from '@algominutes/contracts/schemas';
import { appConfig } from '../services/api/src/routes/app-config.js';

// GET /v1/config: broadcast capture's kill switch. BROADCAST_CAPTURE=off
// hides the entry point; anything else, or unset, leaves it on. The body is
// the AppConfigResponse contract.
describe('app config', () => {
  it('broadcast capture is on unless the env says off', () => {
    expect(appConfig({})).toEqual({ broadcastCapture: true });
    expect(appConfig({ BROADCAST_CAPTURE: 'on' })).toEqual({ broadcastCapture: true });
    expect(appConfig({ BROADCAST_CAPTURE: 'off' })).toEqual({ broadcastCapture: false });
    expect(appConfig({ BROADCAST_CAPTURE: ' OFF ' })).toEqual({ broadcastCapture: false });
  });

  it('matches the AppConfigResponse contract', () => {
    for (const env of [{}, { BROADCAST_CAPTURE: 'off' }]) {
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
});
