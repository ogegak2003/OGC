import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { billableSeconds, priceFor } from './bridge-billing.service.js';
import { canReceiveCodes, checkDestination } from './destination-rules.js';
import { WebhookRejectedError } from './provider/bridge-provider.js';
import { SimulatedBridgeProvider } from './provider/simulated.provider.js';
import { signWebhook, verifyWebhookSignature } from './provider/webhook-signature.js';

// Format and arithmetic checks only: no number here is ever dialled.
const SECRET = 'a'.repeat(48);
const body = Buffer.from('{"events":[]}');
const now = new Date('2026-10-16T12:00:00Z');

describe('Bridge webhook signatures', () => {
  it('accepts a fresh, correctly signed body', () => {
    expect(() => {
      verifyWebhookSignature(SECRET, body, signWebhook(SECRET, body, now), now, 300);
    }).not.toThrow();
  });

  it('rejects missing, malformed, forged, altered and stale signatures', () => {
    const good = signWebhook(SECRET, body, now);
    const cases: [string | undefined, Buffer, Date][] = [
      [undefined, body, now],
      ['nonsense', body, now],
      [signWebhook('b'.repeat(48), body, now), body, now],
      [good, Buffer.from('{"events":[1]}'), now],
      [good, body, new Date(now.getTime() + 301_000)],
    ];
    for (const [header, raw, at] of cases) {
      expect(() => {
        verifyWebhookSignature(SECRET, raw, header, at, 300);
      }).toThrow(WebhookRejectedError);
    }
  });
});

describe('Bridge destination rules (toll-fraud protection)', () => {
  it('allows ordinary Kenyan mobile and fixed-line numbers in an enabled country', () => {
    expect(checkDestination('+254712345678', ['KE'], [])).toEqual({ allowed: true });
    expect(checkDestination('+254202222222', ['KE'], [])).toEqual({ allowed: true });
  });

  it('refuses disabled countries, blocked prefixes, premium-rate and malformed numbers', () => {
    expect(checkDestination('+254712345678', [], [])).toMatchObject({ allowed: false });
    expect(checkDestination('+254712345678', ['KE'], ['+2547123'])).toEqual({
      allowed: false,
      reason: 'BLOCKED_PREFIX',
    });
    expect(checkDestination('+254900223456', ['KE'], [])).toEqual({
      allowed: false,
      reason: 'NUMBER_TYPE',
    });
    expect(checkDestination('+2547', ['KE'], [])).toEqual({ allowed: false, reason: 'INVALID' });
  });

  it('sends codes only to numbers that can receive text messages', () => {
    expect(canReceiveCodes('+254712345678')).toBe(true);
    expect(canReceiveCodes('+254202222222')).toBe(false);
  });
});

describe('Bridge development simulator', () => {
  it('writes codes only to the outbox, masked, and delivers verifiable signed call events', async () => {
    const outboxDir = await mkdtemp(join(tmpdir(), 'ogc-bridge-'));
    const provider = new SimulatedBridgeProvider({
      secret: SECRET,
      outboxDir,
      toleranceSeconds: 300,
      ringAfterMs: 5,
      answerAfterMs: 10,
      hangUpAfterMs: 15,
    });
    expect(provider).toMatchObject({ live: false, simulated: true, codeDelivery: 'simulated' });

    await provider.sendVerificationCode('+254712345678', '123456');
    const [file] = await readdir(outboxDir);
    const text = await readFile(join(outboxDir, file ?? ''), 'utf8');
    expect(text).toMatch(/^SIMULATED — no SMS was sent/);
    expect(text).toContain('123456');
    expect(text).not.toContain('712345678');

    const statuses: string[] = [];
    provider.attach({
      deliver: (_name, raw, headers) => {
        // Every simulated event passes the same verification a real webhook must.
        for (const e of provider.parseWebhook(raw, headers, new Date())) statuses.push(e.status);
        return Promise.resolve();
      },
    });
    await provider.startCall({
      callId: 'c',
      from: '+254712345670',
      to: '+254712345678',
      maxDurationSeconds: 60,
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(statuses).toEqual(['RINGING', 'ANSWERED', 'COMPLETED']);
  });
});

describe('Bridge billing arithmetic', () => {
  it('rounds billable time up to the increment and prices whole minor units', () => {
    expect(billableSeconds(0, 60)).toBe(0);
    expect(billableSeconds(1, 60)).toBe(60);
    expect(billableSeconds(61, 60)).toBe(120);
    expect(billableSeconds(61, 1)).toBe(61);
    expect(priceFor(120, 500)).toBe(1000);
    expect(priceFor(61, 500)).toBe(509); // 508.33 rounded up
  });
});
