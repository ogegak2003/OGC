import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { iceServersFor } from './ice-servers.js';

const secret = 'test-only-turn-secret-0123456789abcdef';
const callId = '0192f3a0-7c1e-7d4b-9a2e-3f6b8c1d2e4f';

describe('ICE servers', () => {
  it('offers nothing when no STUN or TURN server is configured (same-network calls only)', () => {
    expect(
      iceServersFor(
        { stunUrls: [], turnUrls: [], turnSecret: undefined, turnTtlSeconds: 3600 },
        callId,
      ),
    ).toEqual([]);
  });

  it('issues short-lived TURN REST API credentials bound to the call', () => {
    const now = Date.UTC(2026, 9, 15, 12, 0, 0);
    const servers = iceServersFor(
      {
        stunUrls: ['stun:stun.example.org:3478'],
        turnUrls: ['turn:turn.example.org:3478?transport=udp', 'turns:turn.example.org:5349'],
        turnSecret: secret,
        turnTtlSeconds: 3600,
      },
      callId,
      now,
    );
    expect(servers[0]).toEqual({ urls: ['stun:stun.example.org:3478'] });
    const turn = servers[1];
    const expires = now / 1000 + 3600;
    expect(turn?.username).toBe(`${String(expires)}:${callId}`);
    // What coturn computes with `use-auth-secret` / `static-auth-secret`.
    expect(turn?.credential).toBe(
      createHmac('sha1', secret)
        .update(`${String(expires)}:${callId}`)
        .digest('base64'),
    );
    // The shared secret itself never appears in what clients receive.
    expect(JSON.stringify(servers)).not.toContain(secret);
  });

  it('omits TURN without a secret instead of issuing unusable credentials', () => {
    const servers = iceServersFor(
      {
        stunUrls: [],
        turnUrls: ['turn:turn.example.org'],
        turnSecret: undefined,
        turnTtlSeconds: 3600,
      },
      callId,
    );
    expect(servers).toEqual([]);
  });
});
