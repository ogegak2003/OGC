import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebhookRejectedError } from './bridge-provider.js';

/**
 * Signed webhooks in the common provider style: header `t=<unix seconds>,v1=<hex HMAC>`, where
 * the HMAC-SHA-256 covers `<t>.<raw body>`. The timestamp bounds replay to a short window; the
 * event IDs inside (unique in the database) stop replays within it.
 */
export const SIGNATURE_HEADER = 'x-ogc-bridge-signature';

export function signWebhook(secret: string, rawBody: Buffer, now: Date): string {
  const t = Math.floor(now.getTime() / 1000);
  const mac = createHmac('sha256', secret)
    .update(`${String(t)}.`)
    .update(rawBody)
    .digest('hex');
  return `t=${String(t)},v1=${mac}`;
}

export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer,
  header: string | undefined,
  now: Date,
  toleranceSeconds: number,
): void {
  if (!header) throw new WebhookRejectedError('missing signature');
  const parts = Object.fromEntries(
    header.split(',').map((part) => {
      const [key, ...rest] = part.trim().split('=');
      return [key ?? '', rest.join('=')];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1 ?? '';
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(v1)) {
    throw new WebhookRejectedError('malformed signature');
  }
  if (Math.abs(now.getTime() / 1000 - t) > toleranceSeconds) {
    throw new WebhookRejectedError('stale signature');
  }
  const expected = createHmac('sha256', secret)
    .update(`${String(t)}.`)
    .update(rawBody)
    .digest();
  const given = Buffer.from(v1, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new WebhookRejectedError('bad signature');
  }
}
