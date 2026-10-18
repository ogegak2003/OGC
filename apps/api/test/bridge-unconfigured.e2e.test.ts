import type { BridgeStatusView } from '@ogc/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestApp, createTestApp, signedInUser } from './support/test-app.js';

/** The error code of an API error response. */
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { code?: string }).code;

/** OGC Bridge switched on but with no provider: truthful "not configured", nothing dialled. */
describe('OGC Bridge without a provider', () => {
  let t: TestApp;

  beforeAll(async () => {
    process.env.BRIDGE_ENABLED = 'true';
    process.env.BRIDGE_PROVIDER = 'disabled';
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('says "not configured" instead of pretending to send codes or place calls', async () => {
    const user = await signedInUser(t, 'NoProvider');
    const status = (await user.as(request(t.server).get('/api/v1/bridge')).expect(200))
      .body as BridgeStatusView;
    expect(status).toMatchObject({ enabled: true, provider: 'disabled', liveDialing: false });
    await user
      .as(request(t.server).post('/api/v1/bridge/number/verification'))
      .send({ country: 'KE', number: '0712000001', consent: true })
      .expect(503)
      .expect((res) => {
        expect(codeOf(res)).toBe('BRIDGE_NOT_CONFIGURED');
      });
    await user
      .as(request(t.server).get(`/api/v1/bridge/eligibility?ogcId=${user.ogcId}`))
      .expect(200)
      .expect((res) => {
        expect(res.body).toEqual({ eligible: false, reason: 'NOT_CONFIGURED' });
      });
    expect(await t.prisma.bridgeVerification.count({ where: { userId: user.userId } })).toBe(0);
  });
});
