import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { AccountView, AuthResponse, RegisterResponse, VerifyEmailResponse } from '@ogc/types';
import {
  type DeviceInfo,
  type LoginInput,
  type RegisterInput,
  loginRequestSchema,
  refreshRequestSchema,
  registerRequestSchema,
  verifyEmailRequestSchema,
} from '@ogc/validation';
import type { Request, Response } from 'express';
import { ApiException, unauthenticated } from '../../common/errors.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { requestMeta } from '../../common/request-meta.js';
import type { Env } from '../../config/env.schema.js';
import { AUTH_RATE_LIMITS } from './auth.constants.js';
import type { AuthContext } from './auth-context.js';
import { AuthService } from './auth.service.js';
import {
  type IssuedTokens,
  clearAuthCookies,
  cookieNames,
  isWebClient,
  readCookie,
  setAuthCookies,
} from './cookies.js';
import { AllowPendingVerification, CurrentAuth, Public } from './decorators.js';
import { SessionService } from './session.service.js';

/**
 * `/api/v1/auth`. Browser clients (`X-OGC-Client: web`) receive HttpOnly
 * cookies and never see tokens; native clients receive tokens in the body
 * and store them in platform secure storage.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private get secureCookies(): boolean {
    return this.config.get('COOKIE_SECURE', { infer: true });
  }

  private respond(
    req: Request,
    res: Response,
    account: AccountView,
    tokens: IssuedTokens,
  ): AuthResponse {
    const session = {
      accessTokenExpiresAt: tokens.accessExpiresAt.toISOString(),
      expiresAt: tokens.expiresAt.toISOString(),
    };
    if (isWebClient(req)) {
      setAuthCookies(res, tokens, this.secureCookies);
      return { account, session };
    }
    return {
      account,
      session,
      tokens: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
    };
  }

  @Public()
  @Throttle({ default: AUTH_RATE_LIMITS.register })
  @Post('register')
  @HttpCode(HttpStatus.ACCEPTED)
  register(
    @Body(new ZodValidationPipe(registerRequestSchema)) body: RegisterInput,
    @Req() req: Request,
  ): Promise<RegisterResponse> {
    return this.auth.register(body, requestMeta(req));
  }

  @Public()
  @Throttle({ default: AUTH_RATE_LIMITS.login })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema)) body: LoginInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const device: DeviceInfo | undefined =
      body.device ?? (isWebClient(req) ? { platform: 'WEB' } : undefined);
    if (!device) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'device: Required');
    }
    const { account, session } = await this.auth.login(body, device, requestMeta(req));
    return this.respond(req, res, account, session);
  }

  @Public()
  @Throttle({ default: AUTH_RATE_LIMITS.refresh })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body(new ZodValidationPipe(refreshRequestSchema)) body: { refreshToken?: string | undefined },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    // Browsers present the cookie (and the CSRF header that selects web mode);
    // native clients present the token in the body.
    const token = isWebClient(req)
      ? readCookie(req, cookieNames(this.secureCookies).refresh)
      : body.refreshToken;
    if (!token) throw unauthenticated();
    try {
      const refreshed = await this.sessions.refresh(token, requestMeta(req));
      return this.respond(req, res, await this.auth.account(refreshed.userId), refreshed);
    } catch (error) {
      if (isWebClient(req)) clearAuthCookies(res, this.secureCookies);
      throw error;
    }
  }

  @AllowPendingVerification()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.sessions.revoke(auth.sessionId, auth.userId, 'LOGOUT', requestMeta(req));
    clearAuthCookies(res, this.secureCookies);
  }

  @AllowPendingVerification()
  @Get('me')
  me(@CurrentAuth() auth: AuthContext): Promise<AccountView> {
    return this.auth.account(auth.userId);
  }

  @Public()
  @Throttle({ default: AUTH_RATE_LIMITS.verifyEmail })
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  async verifyEmail(
    @Body(new ZodValidationPipe(verifyEmailRequestSchema)) body: { token: string },
    @Req() req: Request,
  ): Promise<VerifyEmailResponse> {
    await this.auth.verifyEmail(body.token, requestMeta(req));
    return { verified: true };
  }

  @AllowPendingVerification()
  @Throttle({ default: AUTH_RATE_LIMITS.resendVerification })
  @Post('verify-email/resend')
  @HttpCode(HttpStatus.ACCEPTED)
  async resendVerification(
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    await this.auth.resendVerification(auth.userId, requestMeta(req));
    return { message: 'If your email still needs verifying, a new link is on its way.' };
  }
}
