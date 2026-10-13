import { type ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { AuthenticatedRequest } from '../../modules/auth/auth-context.js';

/**
 * Rate limits signed-in requests per account, and anonymous ones per client IP.
 * Per-account limits stop a single account from enumerating OGC IDs by rotating
 * IP addresses. Runs after `AuthGuard`, so `req.auth` is already verified.
 */
@Injectable()
export class OgcThrottlerGuard extends ThrottlerGuard {
  /** HTTP only: realtime events are rate-limited per account inside the gateway. */
  override canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return Promise.resolve(true);
    return super.canActivate(context);
  }

  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const { auth, ip } = req as unknown as AuthenticatedRequest;
    return Promise.resolve(auth ? `user:${auth.userId}` : `ip:${ip ?? 'unknown'}`);
  }
}
