-- Phase 9: password recovery, retention holds and audit-retention cleanup. Additive only:
-- no existing rows are changed or deleted by this migration.
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEventType" ADD VALUE 'PASSWORD_RESET_REQUESTED';
ALTER TYPE "AuditEventType" ADD VALUE 'PASSWORD_RESET_COMPLETED';
ALTER TYPE "AuditEventType" ADD VALUE 'PASSWORD_RESET_FAILED';
ALTER TYPE "AuditEventType" ADD VALUE 'ACCOUNT_SUSPENDED';
ALTER TYPE "AuditEventType" ADD VALUE 'ACCOUNT_REINSTATED';
ALTER TYPE "AuditEventType" ADD VALUE 'RETENTION_PURGED';

-- AlterEnum
ALTER TYPE "SessionRevocationReason" ADD VALUE 'PASSWORD_RESET';

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_holds" (
    "user_id" UUID NOT NULL,
    "reason" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retention_holds_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_created_at_idx" ON "password_reset_tokens"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "password_reset_tokens_expires_at_idx" ON "password_reset_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Integrity rules (not modelled by Prisma).
ALTER TABLE "password_reset_tokens"
    ADD CONSTRAINT "password_reset_tokens_expiry_after_creation" CHECK ("expires_at" > "created_at"),
    ADD CONSTRAINT "password_reset_tokens_consumed_after_creation"
        CHECK ("consumed_at" IS NULL OR "consumed_at" >= "created_at");
ALTER TABLE "retention_holds"
    ADD CONSTRAINT "retention_holds_reason_not_blank" CHECK (length(btrim("reason")) > 0);

-- The audit log stays append-only: UPDATE is always rejected, and so is DELETE — except for the
-- retention job, which must opt in for its own transaction (SET LOCAL ogc.audit_retention = 'on')
-- and can then remove only events older than 365 days. The floor is enforced here, in the
-- database, whatever the application is configured to do.
CREATE OR REPLACE FUNCTION "ogc_reject_audit_mutation"() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE'
       AND current_setting('ogc.audit_retention', true) = 'on'
       AND OLD."created_at" < now() - interval '365 days' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;
