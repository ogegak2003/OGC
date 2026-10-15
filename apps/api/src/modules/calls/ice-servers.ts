import { createHmac } from 'node:crypto';
import type { IceServerView } from '@ogc/types';

export interface IceConfig {
  stunUrls: string[];
  turnUrls: string[];
  /** coturn `static-auth-secret` (TURN REST API). Never sent to clients. */
  turnSecret: string | undefined;
  turnTtlSeconds: number;
}

/**
 * ICE servers for one call. TURN credentials follow the TURN REST API scheme that coturn
 * implements (`use-auth-secret`): the username is `<expiry unix time>:<label>` and the
 * password is base64(HMAC-SHA1(secret, username)). The TURN server checks the signature and
 * the expiry itself, so credentials are short-lived, scoped to one call, and the shared
 * secret never leaves the API. The label is the call ID — no user identifier reaches the
 * TURN server's logs.
 */
export function iceServersFor(
  config: IceConfig,
  callId: string,
  now: number = Date.now(),
): IceServerView[] {
  const servers: IceServerView[] = [];
  if (config.stunUrls.length > 0) servers.push({ urls: config.stunUrls });
  if (config.turnUrls.length > 0 && config.turnSecret) {
    const expires = Math.floor(now / 1000) + config.turnTtlSeconds;
    const username = `${String(expires)}:${callId}`;
    const credential = createHmac('sha1', config.turnSecret).update(username).digest('base64');
    servers.push({ urls: config.turnUrls, username, credential });
  }
  return servers;
}
