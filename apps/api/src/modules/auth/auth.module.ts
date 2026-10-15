import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { EmailModule } from '../email/email.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { AccountStatusService } from './account-status.service.js';
import { AdminAccountsController } from './admin-accounts.controller.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { PasswordHasher } from './password-hasher.js';
import { SessionService } from './session.service.js';

@Module({
  imports: [AuditModule, EmailModule, IdentityModule],
  controllers: [AuthController, AdminAccountsController],
  providers: [AuthService, SessionService, AccountStatusService, PasswordHasher, AuthGuard],
  exports: [SessionService, AuthGuard],
})
export class AuthModule {}
