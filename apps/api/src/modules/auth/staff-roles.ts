import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  SetMetadata,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiException, unauthenticated } from '../../common/errors.js';
import type { StaffRole } from '../../generated/prisma/client.js';
import type { AuthenticatedRequest } from './auth-context.js';

const STAFF_ROLES = 'ogc:staffRoles';

/** Allows the request only if the signed-in user holds at least one of `roles`. */
@Injectable()
export class StaffRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<StaffRole[] | undefined>(STAFF_ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;
    const { auth } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!auth) throw unauthenticated();
    if (!auth.staffRoles.some((role) => required.includes(role))) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        'FORBIDDEN',
        'You do not have access to this resource',
      );
    }
    return true;
  }
}

/** Restricts a route to platform staff holding one of the given roles. */
export const RequireStaffRole = (...roles: StaffRole[]): MethodDecorator & ClassDecorator =>
  applyDecorators(SetMetadata(STAFF_ROLES, roles), UseGuards(StaffRolesGuard));
