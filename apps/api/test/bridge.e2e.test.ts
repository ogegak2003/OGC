import { randomUUID } from 'node:crypto';
import type {
  BridgeCallView,
  BridgeStatusView,
  BridgeUsageView,
  BridgeVerificationView,
} from '@ogc/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BRIDGE_PROVIDER,
  type BridgeProvider,
  type ProviderCallEvent,
  ProviderUnavailableError,
  WebhookRejectedError,
} from '../src/modules/bridge/provider/bridge-provider.js';
import {
  SIGNATURE_HEADER,
  signWebhook,
  verifyWebhookSignature,
} from '../src/modules/bridge/provider/webhook-signature.js';
import {
  type TestApp,
  type TestUser,
  createTestApp,
  makeContacts,
  signedInUser,
} from './support/test-app.js';

/** The error code of an API error response. */
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { code?: string }).code;

/**
 * OGC Bridge end to end against a live API and PostgreSQL. SIMULATED: the provider below is a
 * scripted test double — it reaches no telephone, and every "provider event" is a webhook this
 * test signs and posts. These tests prove OGC's own logic (verification, routing, limits,
 * webhook authentication, state, billing); they are not evidence of real PSTN connectivity.
 */
const SECRET = 'bridge-test-webhook-secret-0123456789abcdef';

class ScriptedProvider implements BridgeProvider {
  readonly name = 'scripted';
  readonly live = true;
  readonly simulated = false;
  readonly codeDelivery = 'sms' as const;
  readonly codes = new Map<string, string>();
  readonly started: { callId: string; from: string; to: string; providerCallId: string }[] = [];
  readonly ended: string[] = [];
  failNextStart = false;

  sendVerificationCode(to: string, code: string): Promise<void> {
    this.codes.set(to, code);
    return Promise.resolve();
  }

  startCall(req: {
    callId: string;
    from: string;
    to: string;
  }): Promise<{ providerCallId: string }> {
    if (this.failNextStart) {
      this.failNextStart = false;
      return Promise.reject(new ProviderUnavailableError('outage'));
    }
    const providerCallId = `scr_${randomUUID()}`;
    this.started.push({ callId: req.callId, from: req.from, to: req.to, providerCallId });
    return Promise.resolve({ providerCallId });
  }

  endCall(providerCallId: string): Promise<void> {
    this.ended.push(providerCallId);
    return Promise.resolve();
  }

  callStatus(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
    now: Date,
  ): ProviderCallEvent[] {
    verifyWebhookSignature(SECRET, rawBody, headers[SIGNATURE_HEADER], now, 300);
    try {
      const { events } = JSON.parse(rawBody.toString('utf8')) as {
        events: (Omit<ProviderCallEvent, 'occurredAt'> & { occurredAt: string })[];
      };
      return events.map((e) => ({ ...e, occurredAt: new Date(e.occurredAt) }));
    } catch {
      throw new WebhookRejectedError('malformed body');
    }
  }
}

describe('OGC Bridge (simulated provider)', () => {
  let t: TestApp;
  let provider: ScriptedProvider;
  let ann: TestUser;
  let ben: TestUser;
  let cat: TestUser;
  let dan: TestUser;
  let eve: TestUser;
  let fay: TestUser;
  let tariffPrice: number;

  const api = (user: TestUser, method: 'get' | 'post' | 'patch' | 'delete', path: string) =>
    user.as(request(t.server)[method](`/api/v1${path}`));

  /** Posts provider events as a signed webhook. */
  const webhook = (
    events: Partial<ProviderCallEvent>[],
    options: { at?: Date; secret?: string; signed?: boolean } = {},
  ) => {
    const at = options.at ?? new Date();
    const body = Buffer.from(
      JSON.stringify({
        events: events.map((e) => ({
          providerEventId: e.providerEventId ?? `evt_${randomUUID()}`,
          occurredAt: (e.occurredAt ?? at).toISOString(),
          ...e,
        })),
      }),
    );
    const req = request(t.server)
      .post('/api/v1/bridge/webhooks/scripted')
      .set('content-type', 'application/json');
    if (options.signed !== false)
      req.set(SIGNATURE_HEADER, signWebhook(options.secret ?? SECRET, body, at));
    // As text: a Buffer with a JSON content type would be re-serialized by the HTTP client.
    return req.send(body.toString('utf8'));
  };

  /** Links a (format-valid, never dialled) number to `user` and lets contacts call it. */
  async function link(user: TestUser, local: string): Promise<void> {
    const started = await api(user, 'post', '/bridge/number/verification')
      .send({ country: 'KE', number: local, consent: true })
      .expect(201);
    const verification = started.body as BridgeVerificationView;
    const e164 = `+254${local.replace(/\D/g, '').replace(/^0/, '')}`;
    const code = provider.codes.get(e164);
    expect(code).toMatch(/^\d{6}$/);
    await api(user, 'post', '/bridge/number/verify')
      .send({ verificationId: verification.id, code })
      .expect(201);
    await api(user, 'patch', '/bridge/number').send({ allowContactCalls: true }).expect(200);
  }

  const startCall = (caller: TestUser, callee: TestUser, key = randomUUID()) =>
    api(caller, 'post', '/bridge/calls').send({ ogcId: callee.ogcId, idempotencyKey: key });

  beforeAll(async () => {
    process.env.BRIDGE_ENABLED = 'true';
    process.env.BRIDGE_PROVIDER = 'simulated';
    process.env.BRIDGE_CODE_SECRET = 'bridge-test-code-secret-0123456789abcdef';
    process.env.BRIDGE_WEBHOOK_SECRET = SECRET;
    process.env.BRIDGE_MAX_CALL_SECONDS = '600';
    process.env.BRIDGE_CONCURRENT_CALLS = '1';
    process.env.BRIDGE_CALLS_PER_DAY = '50';
    process.env.BRIDGE_DAILY_SPEND_LIMIT_MINOR = '20000';
    process.env.LOG_LEVEL = 'debug';
    provider = new ScriptedProvider();
    t = await createTestApp({ overrides: [{ provide: BRIDGE_PROVIDER, useValue: provider }] });
    [ann, ben, cat, dan, eve, fay] = await Promise.all([
      signedInUser(t, 'Ann'),
      signedInUser(t, 'Ben'),
      signedInUser(t, 'Cat'),
      signedInUser(t, 'Dan'),
      signedInUser(t, 'Eve'),
      signedInUser(t, 'Fay'),
    ]);
    await makeContacts(t, ann, ben);
    await makeContacts(t, ann, cat);
    // A test tariff (not a real price): 5.00 KES per minute, billed per minute.
    tariffPrice = 500;
    await t.prisma.bridgeTariff.create({
      data: {
        country: 'KE',
        prefix: '+2547',
        currency: 'KES',
        providerCostPerMinuteMinor: 300,
        pricePerMinuteMinor: tariffPrice,
        billingIncrementSeconds: 60,
      },
    });
  });

  afterAll(async () => {
    await t.close();
  });

  describe('number linking and ownership verification', () => {
    it('reports status, with nothing linked yet', async () => {
      const res = await api(ann, 'get', '/bridge').expect(200);
      const status = res.body as BridgeStatusView;
      expect(status).toMatchObject({ enabled: true, liveDialing: true, number: null });
      expect(status.countries).toEqual([{ code: 'KE', name: 'Kenya', callingCode: '254' }]);
    });

    it('rejects invalid numbers, other countries, landlines and missing consent', async () => {
      for (const body of [
        { country: 'KE', number: '0712', consent: true },
        { country: 'KE', number: '+1 202 555 0143', consent: true },
        { country: 'KE', number: '020 2222222', consent: true },
      ]) {
        const res = await api(eve, 'post', '/bridge/number/verification').send(body).expect(400);
        expect(codeOf(res)).toBe('PHONE_NUMBER_INVALID');
      }
      await api(eve, 'post', '/bridge/number/verification')
        .send({ country: 'KE', number: '0712000009', consent: false })
        .expect(400);
      await api(eve, 'post', '/bridge/number/verification')
        .send({ country: 'UG', number: '0772123456', consent: true })
        .expect(400);
    });

    it('enforces wrong-code limits, expiry and resend cooldown, storing only a hash', async () => {
      const started = await api(dan, 'post', '/bridge/number/verification')
        .send({ country: 'KE', number: '0712000004', consent: true })
        .expect(201);
      const v = started.body as BridgeVerificationView;
      const code = provider.codes.get('+254712000004') ?? '';
      // The code is never stored: only its HMAC.
      const row = await t.prisma.bridgeVerification.findUniqueOrThrow({ where: { id: v.id } });
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toContain(code);

      await api(dan, 'post', '/bridge/number/verification')
        .send({ country: 'KE', number: '0712000004', consent: true })
        .expect(429)
        .expect((res) => {
          expect(codeOf(res)).toBe('RESEND_TOO_SOON');
        });

      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) {
        const res = await api(dan, 'post', '/bridge/number/verify').send({
          verificationId: v.id,
          code: wrong,
        });
        expect(codeOf(res)).toBe(i < 5 ? 'VERIFICATION_FAILED' : 'TOO_MANY_ATTEMPTS');
      }
      // Even the right code is refused after five wrong ones.
      await api(dan, 'post', '/bridge/number/verify')
        .send({ verificationId: v.id, code })
        .expect(429)
        .expect((res) => {
          expect(codeOf(res)).toBe('TOO_MANY_ATTEMPTS');
        });

      // An expired code is refused.
      await t.prisma.bridgeVerification.update({
        where: { id: v.id },
        data: { expiresAt: new Date(Date.now() - 1000), attempts: 0 },
      });
      await api(dan, 'post', '/bridge/number/verify')
        .send({ verificationId: v.id, code })
        .expect(400)
        .expect((res) => {
          expect(codeOf(res)).toBe('VERIFICATION_EXPIRED');
        });
    });

    it('does not let one account confirm another account’s verification', async () => {
      const started = await api(cat, 'post', '/bridge/number/verification')
        .send({ country: 'KE', number: '0712000003', consent: true })
        .expect(201);
      const code = provider.codes.get('+254712000003');
      await api(dan, 'post', '/bridge/number/verify')
        .send({ verificationId: (started.body as BridgeVerificationView).id, code })
        .expect(400);
      expect(await t.prisma.bridgeNumber.count({ where: { userId: dan.userId } })).toBe(0);
    });

    it('links a number after the right code and shows it to its owner masked only', async () => {
      await link(ben, '0712000002');
      const status = (await api(ben, 'get', '/bridge').expect(200)).body as BridgeStatusView;
      expect(status.number).toMatchObject({
        status: 'VERIFIED',
        allowContactCalls: true,
        country: 'KE',
      });
      expect(status.number?.maskedNumber).toMatch(/^\+254 7/);
      expect(JSON.stringify(status)).not.toContain('712000002');
      // Audit entries never contain the number or the code.
      const audits = await t.prisma.auditEvent.findMany({ where: { userId: ben.userId } });
      expect(
        JSON.stringify(audits, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)),
      ).not.toContain('712000002');
    });

    it('moves a number to whoever proves possession (recycled numbers), never two accounts', async () => {
      await link(cat, '0712000005');
      await link(dan, '0712000005');
      const active = await t.prisma.bridgeNumber.findMany({
        where: { e164: '+254712000005', revokedAt: null },
      });
      expect(active.map((n) => n.userId)).toEqual([dan.userId]);
      expect(((await api(cat, 'get', '/bridge')).body as BridgeStatusView).number).toBeNull();
    });

    it('unlinks on request', async () => {
      await api(dan, 'delete', '/bridge/number').expect(204);
      expect(((await api(dan, 'get', '/bridge')).body as BridgeStatusView).number).toBeNull();
      await api(dan, 'delete', '/bridge/number').expect(404);
    });
  });

  describe('identity routing and eligibility', () => {
    it('only lets contacts call an opted-in, verified number, revealing nothing else', async () => {
      const eligible = (caller: TestUser, callee: TestUser) =>
        api(caller, 'get', `/bridge/eligibility?ogcId=${callee.ogcId}`).expect(200);
      // Bridge rings the caller's own phone first: without a verified number, nothing to ring.
      expect((await eligible(ann, ben)).body).toEqual({
        eligible: false,
        reason: 'CALLER_NUMBER_REQUIRED',
      });
      await link(ann, '0712000007');
      expect((await eligible(ann, ben)).body).toEqual({ eligible: true, reason: null });
      // Not a contact.
      await link(fay, '0712000008');
      expect((await eligible(fay, ben)).body).toEqual({ eligible: false, reason: 'NOT_A_CONTACT' });
      // A contact without a linked number and one who has not opted in look the same.
      expect((await eligible(ann, cat)).body).toEqual({ eligible: false, reason: 'UNAVAILABLE' });
      await link(cat, '0712000006');
      await api(cat, 'patch', '/bridge/number').send({ allowContactCalls: false }).expect(200);
      expect((await eligible(ann, cat)).body).toEqual({ eligible: false, reason: 'UNAVAILABLE' });
      // A block (either way) gives the same answer, so it is not revealed.
      await api(cat, 'patch', '/bridge/number').send({ allowContactCalls: true }).expect(200);
      await api(cat, 'post', `/blocks/${ann.ogcId}`).expect(204);
      expect((await eligible(ann, cat)).body).toEqual({ eligible: false, reason: 'UNAVAILABLE' });
      await api(cat, 'delete', `/blocks/${ann.ogcId}`).expect(204);
    });
  });

  describe('calls, webhooks and billing', () => {
    let call: BridgeCallView;
    let providerCallId: string;

    it('starts a call once per idempotency key', async () => {
      const key = randomUUID();
      const before = provider.started.length;
      const first = (await startCall(ann, ben, key).expect(201)).body as BridgeCallView;
      const again = (await startCall(ann, ben, key).expect(201)).body as BridgeCallView;
      expect(again.id).toBe(first.id);
      expect(provider.started.length).toBe(before + 1);
      call = first;
      providerCallId = provider.started.at(-1)?.providerCallId ?? '';
      expect(provider.started.at(-1)).toMatchObject({ from: '+254712000007', to: '+254712000002' });
      expect(call).toMatchObject({ status: 'REQUESTED', simulated: false, country: 'KE' });
      // The caller never sees the callee's number.
      expect(JSON.stringify(call)).not.toContain('712000002');
    });

    it('refuses a second concurrent call (limit) without contacting the provider', async () => {
      const before = provider.started.length;
      await startCall(ann, ben)
        .expect(429)
        .expect((res) => {
          expect(codeOf(res)).toBe('BRIDGE_LIMIT_REACHED');
        });
      expect(provider.started.length).toBe(before);
    });

    it('rejects unsigned, forged and stale webhooks', async () => {
      await webhook([{ providerCallId, status: 'RINGING' }], { signed: false }).expect(401);
      await webhook([{ providerCallId, status: 'RINGING' }], { secret: 'x'.repeat(48) }).expect(
        401,
      );
      await webhook([{ providerCallId, status: 'RINGING' }], {
        at: new Date(Date.now() - 10 * 60_000),
      }).expect(401);
      expect(
        ((await api(ann, 'get', `/bridge/calls/${call.id}`)).body as BridgeCallView).status,
      ).toBe('REQUESTED');
      expect(await t.prisma.auditEvent.count({ where: { type: 'BRIDGE_WEBHOOK_REJECTED' } })).toBe(
        3,
      );
    });

    it('applies provider progress once, in order, ignoring replays and late events', async () => {
      const ringing = {
        providerEventId: `evt_${randomUUID()}`,
        providerCallId,
        status: 'RINGING' as const,
      };
      await webhook([ringing]).expect(204);
      await webhook([ringing]).expect(204); // replayed: stored once, no effect
      const answeredAt = new Date(Date.now() - 61_000);
      await webhook([{ providerCallId, status: 'ANSWERED', occurredAt: answeredAt }]).expect(204);
      // A late RINGING (delivered out of order) does not move the call backwards.
      await webhook([
        { providerCallId, status: 'RINGING', occurredAt: new Date(answeredAt.getTime() - 1000) },
      ]).expect(204);
      const view = (await api(ann, 'get', `/bridge/calls/${call.id}`)).body as BridgeCallView;
      expect(view.status).toBe('ANSWERED');
      expect(await t.prisma.bridgeCallEvent.count({ where: { callId: call.id } })).toBe(3);
    });

    it('charges a completed call exactly once, from the provider duration', async () => {
      const completed = {
        providerEventId: `evt_${randomUUID()}`,
        providerCallId,
        status: 'COMPLETED' as const,
        durationSeconds: 61,
      };
      await webhook([completed]).expect(204);
      await webhook([completed]).expect(204); // replay
      await webhook([{ providerCallId, status: 'FAILED' }]).expect(204); // after final: ignored
      const view = (await api(ann, 'get', `/bridge/calls/${call.id}`)).body as BridgeCallView;
      expect(view).toMatchObject({ status: 'COMPLETED', durationSeconds: 61 });
      // 61 s billed as 2 whole minutes at the test tariff.
      expect(view.charge).toEqual({
        amountMinor: 2 * tariffPrice,
        currency: 'KES',
        state: 'confirmed',
      });
      expect(await t.prisma.bridgeUsageEntry.count({ where: { callId: call.id } })).toBe(1);
      const usage = (await api(ann, 'get', '/bridge/usage').expect(200)).body as BridgeUsageView;
      expect(usage.entries).toHaveLength(1);
    });

    it('never charges busy, unanswered or failed calls', async () => {
      for (const status of ['BUSY', 'NO_ANSWER', 'FAILED'] as const) {
        const view = (await startCall(ann, ben).expect(201)).body as BridgeCallView;
        const pid = provider.started.at(-1)?.providerCallId ?? '';
        await webhook([
          { providerCallId: pid, status, durationSeconds: 30, costMinor: 100, currency: 'KES' },
        ]).expect(204);
        const after = (await api(ann, 'get', `/bridge/calls/${view.id}`)).body as BridgeCallView;
        expect(after).toMatchObject({ status, charge: null });
      }
    });

    it('reports a provider outage truthfully and charges nothing', async () => {
      provider.failNextStart = true;
      const view = (await startCall(ann, ben).expect(201)).body as BridgeCallView;
      expect(view).toMatchObject({ status: 'FAILED', charge: null });
      expect(view.failureReason).toMatch(/could not be reached/);
    });

    it('ends a call on request through the provider; only the provider event finishes it', async () => {
      const view = (await startCall(ann, ben).expect(201)).body as BridgeCallView;
      const pid = provider.started.at(-1)?.providerCallId ?? '';
      await api(ann, 'post', `/bridge/calls/${view.id}/end`).expect(201);
      expect(provider.ended).toContain(pid);
      await webhook([{ providerCallId: pid, status: 'CANCELED' }]).expect(204);
      expect(
        ((await api(ann, 'get', `/bridge/calls/${view.id}`)).body as BridgeCallView).status,
      ).toBe('CANCELED');
    });

    it('keeps calls private to their caller', async () => {
      await api(ben, 'get', `/bridge/calls/${call.id}`).expect(404);
      await api(ben, 'post', `/bridge/calls/${call.id}/end`).expect(404);
      const list = (await api(ben, 'get', '/bridge/calls').expect(200)).body as BridgeCallView[];
      expect(list).toEqual([]);
    });

    it('refuses calls over the daily spend cap before contacting the provider', async () => {
      // Confirmed spend so far plus a 10-minute worst case must stay under the 200.00 KES cap.
      await t.prisma.bridgeUsageEntry.create({
        data: {
          userId: ann.userId,
          kind: 'ADJUSTMENT',
          state: 'CONFIRMED',
          currency: 'KES',
          amountMinor: 18_000n,
          externalRef: `test:${randomUUID()}`,
          note: 'test spend',
        },
      });
      const before = provider.started.length;
      await startCall(ann, ben)
        .expect(429)
        .expect((res) => {
          expect(codeOf(res)).toBe('BRIDGE_LIMIT_REACHED');
        });
      expect(provider.started.length).toBe(before);
    });

    it('never writes numbers or codes to the logs', () => {
      const logs = t.logs();
      for (const secret of ['712000002', '712000005', '712000006', ...provider.codes.values()]) {
        expect(logs).not.toContain(secret);
      }
    });
  });

  describe('existing features are unaffected', () => {
    it('still serves OGC-to-OGC call history and contacts', async () => {
      await api(ann, 'get', '/calls').expect(200);
      await api(ann, 'get', '/contacts').expect(200);
    });
  });
});
