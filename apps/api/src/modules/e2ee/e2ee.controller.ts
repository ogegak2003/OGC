import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { DeviceKeyView, WelcomeView } from '@ogc/types';
import {
  registerDeviceKeyRequestSchema,
  uploadKeyPackagesRequestSchema,
  uuidSchema,
} from '@ogc/validation';
import type { Request } from 'express';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { requestMeta } from '../../common/request-meta.js';
import { throttle } from '../../common/throttling/rate-limits.js';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { DeviceKeysService } from './device-keys.service.js';
import { bytesFromBase64 } from '../../common/bytes.js';

/** `/api/v1/e2ee` — this device's encryption identity, key packages and pending Welcomes. */
@Controller('e2ee')
@Throttle({ default: throttle('e2ee') })
export class E2eeController {
  constructor(private readonly keys: DeviceKeysService) {}

  @Put('device-key')
  register(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(registerDeviceKeyRequestSchema))
    body: { signaturePublicKey: string },
    @Req() req: Request,
  ): Promise<DeviceKeyView> {
    return this.keys.register(auth, bytesFromBase64(body.signaturePublicKey), requestMeta(req));
  }

  @Get('device-key')
  current(@CurrentAuth() auth: AuthContext): Promise<DeviceKeyView> {
    return this.keys.current(auth);
  }

  @Post('key-packages')
  @HttpCode(HttpStatus.CREATED)
  upload(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(uploadKeyPackagesRequestSchema)) body: { keyPackages: string[] },
  ): Promise<DeviceKeyView> {
    return this.keys.uploadKeyPackages(auth, body.keyPackages);
  }

  @Get('welcomes')
  welcomes(@CurrentAuth() auth: AuthContext): Promise<WelcomeView[]> {
    return this.keys.welcomes(auth);
  }

  @Delete('welcomes/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  acknowledge(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<void> {
    return this.keys.acknowledgeWelcome(auth, id);
  }
}
