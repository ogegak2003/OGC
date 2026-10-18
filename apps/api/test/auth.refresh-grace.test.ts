import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  REFRESH_GRACE_MAX_TOKENS,
  REFRESH_GRACE_WINDOW_MS,
} from '../src/modules/auth/auth.constants.js';
import { hashToken } from '../src/modules/auth/tokens.js';
import { listen } from './support/messaging.js';
import {
  PASSWORD,
  type TestApp,
  clientIp,
  cookieHeader,
  createActiveAccount,
  createTestApp,
  nativeTokens,
} from './support/test-app.js';

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

describe('refresh-token grace window', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    // Listening once lets supertest reuse the server for concurrent requests.
    await listen(t);
  });

  afterAll(async () => {
    await t.close();
  });

  const me = (accessToken: string) =>
    request(t.server).get('/api/v1/auth/me').set('Authorization', `Bearer ${accessToken}`);
  const refresh = (refreshToken: string) =>
    request(t.server)
      .post('/api/v1/auth/refresh')
      .set('X-Forwarded-For', clientIp())
      .send({ refreshToken });
  const refreshed = async (refreshToken: string): Promise<Tokens> =>
    ((await refresh(refreshToken).expect(200)).body as { tokens: Tokens }).tokens;

  const sessionOf = (refreshToken: string) =>
    t.prisma.session.findUniqueOrThrow({
      where: { id: refreshToken.slice('ogc_rt_'.length, 'ogc_rt_'.length + 36) },
    });
  const closeGraceWindow = async (refreshToken: string) => {
    const session = await sessionOf(refreshToken);
    await t.prisma.session.update({
      where: { id: session.id },
      data: { refreshRotatedAt: new Date(Date.now() - REFRESH_GRACE_WINDOW_MS - 1_000) },
    });
  };
  const reuseEvents = async (refreshToken: string) =>
    t.prisma.auditEvent.count({
      where: {
        sessionId: (await sessionOf(refreshToken)).id,
        type: 'REFRESH_TOKEN_REUSE_DETECTED',
      },
    });

  it('recovers an interrupted refresh: the retried old token still refreshes', async () => {
    const original = await nativeTokens(t, await createActiveAccount(t));
    // The server rotated, but the response never reached the client.
    await refresh(original.refreshToken).expect(200);

    const retried = await refreshed(original.refreshToken);
    await me(retried.accessToken).expect(200);
    const session = await sessionOf(original.refreshToken);
    expect(session.revokedAt).toBeNull();
    expect(await reuseEvents(original.refreshToken)).toBe(0);
    // Only hashes are stored, never the tokens themselves.
    expect(JSON.stringify(session)).not.toContain(original.refreshToken);
    expect(session.supersededRefreshTokenHashes).toContain(hashToken(original.refreshToken));

    const refreshAudits = await t.prisma.auditEvent.findMany({
      where: { sessionId: session.id, type: 'SESSION_REFRESHED' },
    });
    expect(refreshAudits.map((event) => event.metadata)).toContainEqual({ grace: true });
    expect(JSON.stringify(refreshAudits)).not.toContain(original.refreshToken);

    // The recovered token keeps working as the current one.
    await me((await refreshed(retried.refreshToken)).accessToken).expect(200);
  });

  it('allows repeated retries of the same token within the window', async () => {
    const original = await nativeTokens(t, await createActiveAccount(t));
    await refresh(original.refreshToken).expect(200);
    await refresh(original.refreshToken).expect(200);
    const last = await refreshed(original.refreshToken);
    await me(last.accessToken).expect(200);
    expect((await sessionOf(original.refreshToken)).revokedAt).toBeNull();
  });

  it('serves concurrent refreshes of one token without revoking the session', async () => {
    const original = await nativeTokens(t, await createActiveAccount(t));
    const responses = await Promise.all([1, 2, 3].map(() => refresh(original.refreshToken)));
    expect(responses.map((res) => res.status)).toEqual([200, 200, 200]);

    const issued = responses.map((res) => (res.body as { tokens: Tokens }).tokens);
    expect(new Set(issued.map((tokens) => tokens.refreshToken)).size).toBe(3);
    const session = await sessionOf(original.refreshToken);
    expect(session.revokedAt).toBeNull();
    // Exactly one of the issued tokens is current; the others are still honoured in the window.
    const isCurrent = (tokens: Tokens) =>
      hashToken(tokens.refreshToken) === session.refreshTokenHash;
    const current = issued.filter(isCurrent);
    const others = issued.filter((tokens) => !isCurrent(tokens));
    expect(current).toHaveLength(1);
    // A grace refresh keeps every issued token in the open window, the current one included.
    for (const tokens of [...others.slice(0, 1), ...current]) {
      await refresh(tokens.refreshToken).expect(200);
    }
    expect((await sessionOf(original.refreshToken)).revokedAt).toBeNull();
  });

  it('serves concurrent cookie refreshes from two browser tabs', async () => {
    const email = await createActiveAccount(t);
    const login = await request(t.server)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', clientIp())
      .set('X-OGC-Client', 'web')
      .send({ email, password: PASSWORD })
      .expect(200);
    const cookie = cookieHeader(login);
    const tab = () =>
      request(t.server)
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookie)
        .set('X-OGC-Client', 'web')
        .set('X-Forwarded-For', clientIp())
        .send({});
    const [a, b] = await Promise.all([tab(), tab()]);
    expect([a.status, b.status]).toEqual([200, 200]);
    // The browser keeps one tab's cookies (shared jar). The harder case is keeping the tab whose
    // refresh cookie was already superseded: its access cookie fails, but the refresh renews.
    const refreshCookie = (res: request.Response) =>
      decodeURIComponent(/ogc_rt=([^;]+)/.exec(cookieHeader(res))?.[1] ?? '');
    const { refreshTokenHash } = await sessionOf(refreshCookie(a));
    const stale = hashToken(refreshCookie(a)) === refreshTokenHash ? b : a;
    await request(t.server).get('/api/v1/auth/me').set('Cookie', cookieHeader(stale)).expect(401);
    const renewed = await request(t.server)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookieHeader(stale))
      .set('X-OGC-Client', 'web')
      .set('X-Forwarded-For', clientIp())
      .send({})
      .expect(200);
    await request(t.server).get('/api/v1/auth/me').set('Cookie', cookieHeader(renewed)).expect(200);
  });

  it('treats the superseded token as reuse once the window has passed', async () => {
    const original = await nativeTokens(t, await createActiveAccount(t));
    const rotated = await refreshed(original.refreshToken);
    await closeGraceWindow(original.refreshToken);

    await refresh(original.refreshToken).expect(401);
    await me(rotated.accessToken).expect(401);
    await refresh(rotated.refreshToken).expect(401);
    const session = await sessionOf(original.refreshToken);
    expect(session.revocationReason).toBe('REFRESH_TOKEN_REUSE');
    expect(await reuseEvents(original.refreshToken)).toBe(1);
  });

  it('does not extend the window through grace use', async () => {
    const original = await nativeTokens(t, await createActiveAccount(t));
    await refresh(original.refreshToken).expect(200);
    const { refreshRotatedAt } = await sessionOf(original.refreshToken);
    await refresh(original.refreshToken).expect(200);
    expect((await sessionOf(original.refreshToken)).refreshRotatedAt).toEqual(refreshRotatedAt);
  });

  it('revokes on replay of a token older than the last rotation, even inside the window', async () => {
    const original = await nativeTokens(t, await createActiveAccount(t));
    const second = await refreshed(original.refreshToken);
    // A normal rotation from the current token closes the earlier window.
    const third = await refreshed(second.refreshToken);

    await refresh(original.refreshToken).expect(401);
    await me(third.accessToken).expect(401);
    expect((await sessionOf(original.refreshToken)).revocationReason).toBe('REFRESH_TOKEN_REUSE');
  });

  it('revokes on an unknown token for the session', async () => {
    const original = await nativeTokens(t, await createActiveAccount(t));
    await refresh(original.refreshToken).expect(200);
    const sessionId = (await sessionOf(original.refreshToken)).id;
    await refresh(`ogc_rt_${sessionId}_${'a'.repeat(43)}`).expect(401);
    expect((await sessionOf(original.refreshToken)).revocationReason).toBe('REFRESH_TOKEN_REUSE');
  });

  it('caps grace refreshes per window without revoking the session', async () => {
    const original = await nativeTokens(t, await createActiveAccount(t));
    let latest = await refreshed(original.refreshToken);
    for (let i = 1; i < REFRESH_GRACE_MAX_TOKENS; i++) {
      latest = await refreshed(original.refreshToken);
    }
    await refresh(original.refreshToken).expect(401);
    const session = await sessionOf(original.refreshToken);
    expect(session.revokedAt).toBeNull();
    // The holder of the current token is unaffected.
    await me(latest.accessToken).expect(200);
    await refresh(latest.refreshToken).expect(200);
  });

  it('never restores a signed-out session through a grace token', async () => {
    const original = await nativeTokens(t, await createActiveAccount(t));
    const rotated = await refreshed(original.refreshToken);
    await request(t.server)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${rotated.accessToken}`)
      .expect(204);

    await refresh(original.refreshToken).expect(401);
    await refresh(rotated.refreshToken).expect(401);
    const session = await sessionOf(original.refreshToken);
    expect(session.revocationReason).toBe('LOGOUT');
    expect(session.refreshTokenHash).toBe(hashToken(rotated.refreshToken));
  });

  it('never restores a session revoked for reuse', async () => {
    const original = await nativeTokens(t, await createActiveAccount(t));
    const rotated = await refreshed(original.refreshToken);
    await closeGraceWindow(original.refreshToken);
    await refresh(original.refreshToken).expect(401);

    // Re-opening the window afterwards still cannot bring the session back.
    await t.prisma.session.update({
      where: { id: (await sessionOf(original.refreshToken)).id },
      data: { refreshRotatedAt: new Date() },
    });
    await refresh(original.refreshToken).expect(401);
    await refresh(rotated.refreshToken).expect(401);
    expect((await sessionOf(original.refreshToken)).revocationReason).toBe('REFRESH_TOKEN_REUSE');
  });

  it('cuts off a suspended account even inside the window', async () => {
    const email = await createActiveAccount(t);
    const original = await nativeTokens(t, email);
    await refresh(original.refreshToken).expect(200);
    await t.prisma.user.update({ where: { email }, data: { status: 'SUSPENDED' } });

    const res = await refresh(original.refreshToken);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' });
    expect((await sessionOf(original.refreshToken)).revocationReason).toBe('ACCOUNT_DISABLED');
  });

  it('keeps sessions created before the migration working (no window open)', async () => {
    const original = await nativeTokens(t, await createActiveAccount(t));
    const fresh = await sessionOf(original.refreshToken);
    expect(fresh.refreshRotatedAt).toBeNull();
    expect(fresh.supersededRefreshTokenHashes).toEqual([]);
    await me((await refreshed(original.refreshToken)).accessToken).expect(200);
  });
});
