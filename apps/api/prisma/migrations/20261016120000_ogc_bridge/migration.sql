-- OGC Bridge (calls to telephone networks). Additive only: new enum values, new bridge_* tables
-- and indexes. No existing table or row is changed or deleted; Bridge stays off until
-- BRIDGE_ENABLED=true.

-- CreateEnum
CREATE TYPE "BridgeNumberStatus" AS ENUM ('VERIFIED', 'REVOKED');

-- CreateEnum
CREATE TYPE "BridgeNumberRevocationReason" AS ENUM ('UNLINKED', 'REPLACED', 'ACCOUNT_CLOSED', 'ADMIN');

-- CreateEnum
CREATE TYPE "BridgeCallStatus" AS ENUM ('REQUESTED', 'RINGING', 'ANSWERED', 'COMPLETED', 'BUSY', 'NO_ANSWER', 'REJECTED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "BridgeUsageKind" AS ENUM ('CHARGE', 'ADJUSTMENT', 'REFUND');

-- CreateEnum
CREATE TYPE "BridgeUsageState" AS ENUM ('ESTIMATE', 'CONFIRMED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEventType" ADD VALUE 'BRIDGE_VERIFICATION_STARTED';
ALTER TYPE "AuditEventType" ADD VALUE 'BRIDGE_VERIFICATION_FAILED';
ALTER TYPE "AuditEventType" ADD VALUE 'BRIDGE_NUMBER_VERIFIED';
ALTER TYPE "AuditEventType" ADD VALUE 'BRIDGE_NUMBER_UNLINKED';
ALTER TYPE "AuditEventType" ADD VALUE 'BRIDGE_CALL_REQUESTED';
ALTER TYPE "AuditEventType" ADD VALUE 'BRIDGE_CALL_ENDED';
ALTER TYPE "AuditEventType" ADD VALUE 'BRIDGE_WEBHOOK_REJECTED';
ALTER TYPE "AuditEventType" ADD VALUE 'BRIDGE_USAGE_ADJUSTED';

-- CreateTable
CREATE TABLE "bridge_numbers" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "e164" VARCHAR(16) NOT NULL,
    "country" CHAR(2) NOT NULL,
    "status" "BridgeNumberStatus" NOT NULL DEFAULT 'VERIFIED',
    "allow_contact_calls" BOOLEAN NOT NULL DEFAULT false,
    "consented_at" TIMESTAMPTZ(3) NOT NULL,
    "verified_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revocation_reason" "BridgeNumberRevocationReason",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bridge_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bridge_verifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "e164" VARCHAR(16) NOT NULL,
    "country" CHAR(2) NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "delivery" VARCHAR(16) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sends" INTEGER NOT NULL DEFAULT 1,
    "last_sent_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bridge_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bridge_calls" (
    "id" UUID NOT NULL,
    "caller_id" UUID NOT NULL,
    "callee_id" UUID NOT NULL,
    "number_id" UUID NOT NULL,
    "country" CHAR(2) NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "provider_call_id" VARCHAR(128),
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "status" "BridgeCallStatus" NOT NULL DEFAULT 'REQUESTED',
    "idempotency_key" UUID NOT NULL,
    "max_duration_seconds" INTEGER NOT NULL,
    "duration_seconds" INTEGER,
    "failure_reason" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answered_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "last_event_at" TIMESTAMPTZ(3),

    CONSTRAINT "bridge_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bridge_call_events" (
    "id" UUID NOT NULL,
    "call_id" UUID NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "provider_event_id" VARCHAR(128) NOT NULL,
    "status" "BridgeCallStatus" NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "duration_seconds" INTEGER,
    "provider_cost_minor" BIGINT,
    "currency" CHAR(3),

    CONSTRAINT "bridge_call_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bridge_tariffs" (
    "id" UUID NOT NULL,
    "country" CHAR(2) NOT NULL,
    "prefix" VARCHAR(16) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "provider_cost_per_minute_minor" INTEGER NOT NULL,
    "price_per_minute_minor" INTEGER NOT NULL,
    "billing_increment_seconds" INTEGER NOT NULL DEFAULT 60,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bridge_tariffs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bridge_usage_entries" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "call_id" UUID,
    "kind" "BridgeUsageKind" NOT NULL,
    "state" "BridgeUsageState" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "provider_cost_minor" BIGINT,
    "external_ref" VARCHAR(128) NOT NULL,
    "note" VARCHAR(200),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bridge_usage_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bridge_numbers_user_id_idx" ON "bridge_numbers"("user_id");

-- CreateIndex
CREATE INDEX "bridge_verifications_user_id_created_at_idx" ON "bridge_verifications"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "bridge_verifications_e164_created_at_idx" ON "bridge_verifications"("e164", "created_at");

-- CreateIndex
CREATE INDEX "bridge_calls_caller_id_created_at_idx" ON "bridge_calls"("caller_id", "created_at");

-- CreateIndex
CREATE INDEX "bridge_calls_status_created_at_idx" ON "bridge_calls"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "bridge_calls_caller_id_idempotency_key_key" ON "bridge_calls"("caller_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "bridge_calls_provider_provider_call_id_key" ON "bridge_calls"("provider", "provider_call_id");

-- CreateIndex
CREATE INDEX "bridge_call_events_call_id_occurred_at_idx" ON "bridge_call_events"("call_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "bridge_call_events_provider_provider_event_id_key" ON "bridge_call_events"("provider", "provider_event_id");

-- CreateIndex
CREATE INDEX "bridge_tariffs_country_active_idx" ON "bridge_tariffs"("country", "active");

-- CreateIndex
CREATE UNIQUE INDEX "bridge_usage_entries_external_ref_key" ON "bridge_usage_entries"("external_ref");

-- CreateIndex
CREATE INDEX "bridge_usage_entries_user_id_created_at_idx" ON "bridge_usage_entries"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "bridge_numbers" ADD CONSTRAINT "bridge_numbers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bridge_verifications" ADD CONSTRAINT "bridge_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bridge_calls" ADD CONSTRAINT "bridge_calls_caller_id_fkey" FOREIGN KEY ("caller_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bridge_calls" ADD CONSTRAINT "bridge_calls_callee_id_fkey" FOREIGN KEY ("callee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bridge_calls" ADD CONSTRAINT "bridge_calls_number_id_fkey" FOREIGN KEY ("number_id") REFERENCES "bridge_numbers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bridge_call_events" ADD CONSTRAINT "bridge_call_events_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "bridge_calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bridge_usage_entries" ADD CONSTRAINT "bridge_usage_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bridge_usage_entries" ADD CONSTRAINT "bridge_usage_entries_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "bridge_calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------
-- Hand-written: rules Prisma cannot express.
-- ---------------------------------------------------------------------------------------------

-- A number is actively linked to at most one account, and an account has at most one active
-- number. Revoked rows stay for audit and do not block a later, verified re-link.
CREATE UNIQUE INDEX "bridge_numbers_active_e164_key" ON "bridge_numbers"("e164") WHERE "revoked_at" IS NULL;
CREATE UNIQUE INDEX "bridge_numbers_active_user_key" ON "bridge_numbers"("user_id") WHERE "revoked_at" IS NULL;

-- Active calls, for the concurrent-call limit and the reconciliation sweeper.
CREATE INDEX "bridge_calls_active_idx" ON "bridge_calls"("caller_id")
  WHERE "status" IN ('REQUESTED', 'RINGING', 'ANSWERED');

ALTER TABLE "bridge_numbers"
  ADD CONSTRAINT "bridge_numbers_e164_check" CHECK ("e164" ~ '^\+[1-9][0-9]{6,14}$'),
  ADD CONSTRAINT "bridge_numbers_country_check" CHECK ("country" ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT "bridge_numbers_revoked_check" CHECK (
    ("status" = 'REVOKED') = ("revoked_at" IS NOT NULL)
  );

ALTER TABLE "bridge_verifications"
  ADD CONSTRAINT "bridge_verifications_e164_check" CHECK ("e164" ~ '^\+[1-9][0-9]{6,14}$'),
  ADD CONSTRAINT "bridge_verifications_country_check" CHECK ("country" ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT "bridge_verifications_hash_check" CHECK ("code_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "bridge_verifications_counts_check" CHECK ("attempts" >= 0 AND "sends" >= 1),
  ADD CONSTRAINT "bridge_verifications_delivery_check" CHECK ("delivery" IN ('sms', 'simulated'));

ALTER TABLE "bridge_calls"
  ADD CONSTRAINT "bridge_calls_country_check" CHECK ("country" ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT "bridge_calls_max_duration_check" CHECK ("max_duration_seconds" > 0),
  ADD CONSTRAINT "bridge_calls_duration_check" CHECK ("duration_seconds" IS NULL OR "duration_seconds" >= 0),
  ADD CONSTRAINT "bridge_calls_not_self_check" CHECK ("caller_id" <> "callee_id");

ALTER TABLE "bridge_call_events"
  ADD CONSTRAINT "bridge_call_events_duration_check" CHECK ("duration_seconds" IS NULL OR "duration_seconds" >= 0),
  ADD CONSTRAINT "bridge_call_events_cost_check" CHECK (
    ("provider_cost_minor" IS NULL AND "currency" IS NULL)
    OR ("provider_cost_minor" >= 0 AND "currency" ~ '^[A-Z]{3}$')
  );

ALTER TABLE "bridge_tariffs"
  ADD CONSTRAINT "bridge_tariffs_country_check" CHECK ("country" ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT "bridge_tariffs_prefix_check" CHECK ("prefix" ~ '^\+[1-9][0-9]{0,14}$'),
  ADD CONSTRAINT "bridge_tariffs_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "bridge_tariffs_amounts_check" CHECK (
    "provider_cost_per_minute_minor" >= 0 AND "price_per_minute_minor" >= 0
    AND "billing_increment_seconds" BETWEEN 1 AND 60
  );

ALTER TABLE "bridge_usage_entries"
  ADD CONSTRAINT "bridge_usage_entries_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "bridge_usage_entries_sign_check" CHECK (
    ("kind" = 'CHARGE' AND "amount_minor" >= 0)
    OR ("kind" = 'REFUND' AND "amount_minor" <= 0)
    OR "kind" = 'ADJUSTMENT'
  );
