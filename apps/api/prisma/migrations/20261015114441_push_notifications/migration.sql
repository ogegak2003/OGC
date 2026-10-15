-- Phase 7: account notification settings and the durable push delivery queue (ADR-038).
-- Additive only. Push rows hold generic text and routing IDs, never message content.
-- CreateEnum
CREATE TYPE "NotificationPreview" AS ENUM ('GENERIC', 'SENDER');

-- CreateEnum
CREATE TYPE "PushCategory" AS ENUM ('MESSAGE', 'GROUP', 'CHANNEL', 'CALL', 'CONTACT', 'ACCOUNT');

-- CreateEnum
CREATE TYPE "PushDeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'DELIVERED', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "notification_settings" (
    "user_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "messages" BOOLEAN NOT NULL DEFAULT true,
    "groups" BOOLEAN NOT NULL DEFAULT true,
    "channels" BOOLEAN NOT NULL DEFAULT true,
    "contact_requests" BOOLEAN NOT NULL DEFAULT true,
    "calls" BOOLEAN NOT NULL DEFAULT true,
    "preview" "NotificationPreview" NOT NULL DEFAULT 'GENERIC',
    "sound" BOOLEAN NOT NULL DEFAULT true,
    "vibration" BOOLEAN NOT NULL DEFAULT true,
    "quiet_hours_enabled" BOOLEAN NOT NULL DEFAULT false,
    "quiet_start" INTEGER NOT NULL DEFAULT 1320,
    "quiet_end" INTEGER NOT NULL DEFAULT 420,
    "time_zone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "push_deliveries" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "category" "PushCategory" NOT NULL,
    "dedupe_key" VARCHAR(200) NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "body" VARCHAR(120) NOT NULL,
    "data" JSONB NOT NULL,
    "sound" BOOLEAN NOT NULL DEFAULT true,
    "vibration" BOOLEAN NOT NULL DEFAULT true,
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "status" "PushDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "ticket_id" VARCHAR(100),
    "last_error" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "sent_at" TIMESTAMPTZ(3),

    CONSTRAINT "push_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "push_deliveries_status_next_attempt_at_idx" ON "push_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "push_deliveries_created_at_idx" ON "push_deliveries"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "push_deliveries_device_id_dedupe_key_key" ON "push_deliveries"("device_id", "dedupe_key");

-- AddForeignKey
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Integrity rules Prisma cannot model.
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_quiet_range"
    CHECK ("quiet_start" BETWEEN 0 AND 1439 AND "quiet_end" BETWEEN 0 AND 1439 AND "quiet_start" <> "quiet_end");
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_time_zone"
    CHECK (length("time_zone") BETWEEN 1 AND 64);
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_attempts_non_negative"
    CHECK ("attempts" >= 0);
-- A row is SENT/DELIVERED only after the provider accepted it.
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_sent_has_time"
    CHECK ("status" NOT IN ('SENT', 'DELIVERED') OR "sent_at" IS NOT NULL);
