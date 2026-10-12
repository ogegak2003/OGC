import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ApiException, unauthenticated } from '../../common/errors.js';
import type { Env } from '../../config/env.schema.js';
import type { AuthenticatedRequest } from './auth-context.js';
import { cookieNames, passesCsrfCheck, readCookie } from './cookies.js';
import { ALLOW_PENDING_VERIFICATION, IS_PUBLIC } from './decorators.js';
import { SessionService } from './session.service.js';

const BEARER = /^Bearer ([A-Za-z0-9_-]+)$/;

/**
 * Global, deny-by-default authentication. Routes are protected unless marked
 * `@Public()`; only ACTIVE accounts pass unless the route allows pending ones.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const bearer = BEARER.exec(req.get('authorization') ?? '')?.[1];
    const cookie = readCookie(
      req,
      cookieNames(this.config.get('COOKIE_SECURE', { infer: true })).access,
    );
    const via = bearer ? 'bearer' : 'cookie';
    const token = bearer ?? cookie;
    if (!token) throw unauthenticated();

    if (via === 'cookie' && !passesCsrfCheck(req)) {
      throw new ApiException(HttpStatus.FORBIDDEN, 'CSRF_REJECTED', 'Request rejected');
    }

    const auth = await this.sessions.authenticate(token, via);
    const allowPending = this.reflector.getAllAndOverride<boolean | undefined>(
      ALLOW_PENDING_VERIFICATION,
      targets,
    );
    if (auth.accountStatus !== 'ACTIVE' && !allowPending) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        'EMAIL_NOT_VERIFIED',
        'Verify your email address to continue',
      );
    }
    req.auth = auth;
    return true;
  }
}
