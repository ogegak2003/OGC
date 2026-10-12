import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { AuthenticatedRequest } from '../../modules/auth/auth-context.js';

/**
 * Rate limits signed-in requests per account, and anonymous ones per client IP.
 * Per-account limits stop a single account from enumerating OGC IDs by rotating
 * IP addresses. Runs after `AuthGuard`, so `req.auth` is already verified.
 */
@Injectable()
export class OgcThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const { auth, ip } = req as unknown as AuthenticatedRequest;
    return Promise.resolve(auth ? `user:${auth.userId}` : `ip:${ip ?? 'unknown'}`);
  }
}
