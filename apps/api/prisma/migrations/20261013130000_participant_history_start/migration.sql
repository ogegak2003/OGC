-- Phase 4: where a group member's history starts (ADR-031). Additive; existing rows get 0.
-- AlterTable
ALTER TABLE "conversation_participants" ADD COLUMN     "visible_from_version" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_visible_from_non_negative" CHECK ("visible_from_version" >= 0);
