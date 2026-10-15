-- Phase 8: session management (sign out other devices) and password change. Additive enum values.
-- AlterEnum
ALTER TYPE "AuditEventType" ADD VALUE 'PASSWORD_CHANGED';
ALTER TYPE "AuditEventType" ADD VALUE 'PASSWORD_CHANGE_FAILED';
-- AlterEnum
ALTER TYPE "SessionRevocationReason" ADD VALUE 'USER_REVOKED';
ALTER TYPE "SessionRevocationReason" ADD VALUE 'PASSWORD_CHANGED';
