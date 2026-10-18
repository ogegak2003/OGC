import type { BridgeStatusView } from '@ogc/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestApp, type TestUser, createTestApp, signedInUser } from './support/test-app.js';

/** The error code of an API error response. */
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { code?: string }).code;

/** OGC Bridge switched off (the default): nothing changes for anyone. */
describe('OGC Bridge when switched off', () => {
  let t: TestApp;
  let user: TestUser;

  beforeAll(async () => {
    process.env.BRIDGE_ENABLED = 'false';
    t = await createTestApp();
    user = await signedInUser(t, 'Off');
  });

  afterAll(async () => {
    await t.close();
  });

  it('reports "not available" and refuses linking, calls and webhooks', async () => {
    const status = (await user.as(request(t.server).get('/api/v1/bridge')).expect(200))
      .body as BridgeStatusView;
    expect(status).toMatchObject({
      enabled: false,
      liveDialing: false,
      number: null,
      countries: [],
    });
    await user
      .as(request(t.server).post('/api/v1/bridge/number/verification'))
      .send({ country: 'KE', number: '0712000001', consent: true })
      .expect(403)
      .expect((res) => {
        expect(codeOf(res)).toBe('BRIDGE_DISABLED');
      });
    await user
      .as(request(t.server).get(`/api/v1/bridge/eligibility?ogcId=${user.ogcId}`))
      .expect(200)
      .expect((res) => {
        expect(res.body).toEqual({ eligible: false, reason: 'BRIDGE_DISABLED' });
      });
    await request(t.server)
      .post('/api/v1/bridge/webhooks/simulated')
      .set('content-type', 'application/json')
      .send('{"events":[]}')
      .expect(401);
  });

  it('leaves existing calling and messaging endpoints untouched', async () => {
    await user.as(request(t.server).get('/api/v1/calls')).expect(200);
    await user.as(request(t.server).get('/api/v1/contacts')).expect(200);
    await user.as(request(t.server).get('/api/v1/auth/me')).expect(200);
  });
});
