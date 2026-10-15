-- Phase 6: one-to-one voice and video calls (ADR-037). Signaling state and history metadata
-- only; no media, session descriptions or network addresses are stored. Additive.
-- CreateEnum
CREATE TYPE "CallMedia" AS ENUM ('AUDIO', 'VIDEO');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('RINGING', 'ACCEPTED', 'ENDED');

-- CreateEnum
CREATE TYPE "CallOutcome" AS ENUM ('COMPLETED', 'MISSED', 'DECLINED', 'CANCELLED', 'BUSY', 'FAILED');

-- CreateTable
CREATE TABLE "calls" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "caller_id" UUID NOT NULL,
    "callee_id" UUID NOT NULL,
    "caller_device_id" UUID,
    "callee_device_id" UUID,
    "media" "CallMedia" NOT NULL,
    "status" "CallStatus" NOT NULL DEFAULT 'RINGING',
    "outcome" "CallOutcome",
    "hidden_from_callee" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answered_at" TIMESTAMPTZ(3),
    "connected_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "calls_caller_id_id_idx" ON "calls"("caller_id", "id");

-- CreateIndex
CREATE INDEX "calls_callee_id_id_idx" ON "calls"("callee_id", "id");

-- CreateIndex
CREATE INDEX "calls_conversation_id_id_idx" ON "calls"("conversation_id", "id");

-- CreateIndex
CREATE INDEX "calls_status_created_at_idx" ON "calls"("status", "created_at");

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_caller_id_fkey" FOREIGN KEY ("caller_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_callee_id_fkey" FOREIGN KEY ("callee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_caller_device_id_fkey" FOREIGN KEY ("caller_device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_callee_device_id_fkey" FOREIGN KEY ("callee_device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Integrity rules Prisma cannot model.
ALTER TABLE "calls" ADD CONSTRAINT "calls_distinct_participants" CHECK ("caller_id" <> "callee_id");
-- An ended call always has an outcome and an end time; an open one has neither.
ALTER TABLE "calls" ADD CONSTRAINT "calls_ended_has_outcome"
    CHECK ((("status" = 'ENDED') = ("outcome" IS NOT NULL)) AND (("status" = 'ENDED') = ("ended_at" IS NOT NULL)));
-- A ringing call has not been answered on any device.
ALTER TABLE "calls" ADD CONSTRAINT "calls_ringing_unanswered"
    CHECK ("status" <> 'RINGING' OR ("answered_at" IS NULL AND "callee_device_id" IS NULL));
-- Media can only connect after an answer; only connected calls count as completed.
ALTER TABLE "calls" ADD CONSTRAINT "calls_connected_after_answer"
    CHECK ("connected_at" IS NULL OR "answered_at" IS NOT NULL);
ALTER TABLE "calls" ADD CONSTRAINT "calls_completed_connected"
    CHECK ("outcome" IS DISTINCT FROM 'COMPLETED' OR "connected_at" IS NOT NULL);
