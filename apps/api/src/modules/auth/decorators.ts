import { type ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import { unauthenticated } from '../../common/errors.js';
import type { AuthContext, AuthenticatedRequest } from './auth-context.js';

export const IS_PUBLIC = 'ogc:isPublic';
export const ALLOW_PENDING_VERIFICATION = 'ogc:allowPendingVerification';

/** Opts a route out of authentication. Every other route requires a valid session. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

/**
 * Allows accounts that have not verified their email yet. By default only
 * ACTIVE accounts may use authenticated endpoints.
 */
export const AllowPendingVerification = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_PENDING_VERIFICATION, true);

/** Injects the verified `AuthContext` of the current request. */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext => {
    const { auth } = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!auth) throw unauthenticated();
    return auth;
  },
);
