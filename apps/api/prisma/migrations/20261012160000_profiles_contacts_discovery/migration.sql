-- CreateEnum
CREATE TYPE "ProfileVisibility" AS ENUM ('EVERYONE', 'CONTACTS');

-- CreateEnum
CREATE TYPE "ContactRequestPolicy" AS ENUM ('EVERYONE', 'NOBODY');

-- CreateEnum
CREATE TYPE "ContactRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReportCategory" AS ENUM ('SPAM', 'HARASSMENT', 'IMPERSONATION', 'INAPPROPRIATE_CONTENT', 'SCAM_OR_FRAUD', 'OTHER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('MODERATOR', 'ADMIN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEventType" ADD VALUE 'PROFILE_UPDATED';
ALTER TYPE "AuditEventType" ADD VALUE 'PRIVACY_SETTINGS_CHANGED';
ALTER TYPE "AuditEventType" ADD VALUE 'USER_BLOCKED';
ALTER TYPE "AuditEventType" ADD VALUE 'USER_UNBLOCKED';
ALTER TYPE "AuditEventType" ADD VALUE 'USER_REPORTED';

-- AlterTable
ALTER TABLE "profiles" ADD COLUMN     "avatar_key" VARCHAR(128),
ADD COLUMN     "bio" VARCHAR(280),
ADD COLUMN     "contact_request_policy" "ContactRequestPolicy" NOT NULL DEFAULT 'EVERYONE',
ADD COLUMN     "discoverable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "profile_visibility" "ProfileVisibility" NOT NULL DEFAULT 'CONTACTS';

-- CreateTable
CREATE TABLE "staff_roles" (
    "user_id" UUID NOT NULL,
    "role" "StaffRole" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_roles_pkey" PRIMARY KEY ("user_id","role")
);

-- CreateTable
CREATE TABLE "contact_requests" (
    "id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "status" "ContactRequestStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMPTZ(3),

    CONSTRAINT "contact_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocks" (
    "id" UUID NOT NULL,
    "blocker_id" UUID NOT NULL,
    "blocked_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_reports" (
    "id" UUID NOT NULL,
    "reporter_id" UUID,
    "reported_user_id" UUID,
    "category" "ReportCategory" NOT NULL,
    "description" VARCHAR(1000),
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contact_requests_recipient_id_status_id_idx" ON "contact_requests"("recipient_id", "status", "id");

-- CreateIndex
CREATE INDEX "contact_requests_sender_id_status_id_idx" ON "contact_requests"("sender_id", "status", "id");

-- CreateIndex
CREATE INDEX "contacts_owner_id_id_idx" ON "contacts"("owner_id", "id");

-- CreateIndex
CREATE INDEX "contacts_contact_id_idx" ON "contacts"("contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_owner_id_contact_id_key" ON "contacts"("owner_id", "contact_id");

-- CreateIndex
CREATE INDEX "blocks_blocker_id_id_idx" ON "blocks"("blocker_id", "id");

-- CreateIndex
CREATE INDEX "blocks_blocked_id_idx" ON "blocks"("blocked_id");

-- CreateIndex
CREATE UNIQUE INDEX "blocks_blocker_id_blocked_id_key" ON "blocks"("blocker_id", "blocked_id");

-- CreateIndex
CREATE INDEX "user_reports_status_id_idx" ON "user_reports"("status", "id");

-- CreateIndex
CREATE INDEX "user_reports_reported_user_id_idx" ON "user_reports"("reported_user_id");

-- CreateIndex
CREATE INDEX "user_reports_reporter_id_created_at_idx" ON "user_reports"("reporter_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "profiles_avatar_key_key" ON "profiles"("avatar_key");

-- AddForeignKey
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_requests" ADD CONSTRAINT "contact_requests_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_requests" ADD CONSTRAINT "contact_requests_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_reported_user_id_fkey" FOREIGN KEY ("reported_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Integrity rules not expressible in the Prisma schema (see data-model.md).
-- ---------------------------------------------------------------------------

-- Avatar keys are generated by the server only (no client filenames, no paths).
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_avatar_key_format"
    CHECK ("avatar_key" IS NULL OR "avatar_key" ~ '^avatars/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$');

-- Nobody can relate to themselves.
ALTER TABLE "contact_requests" ADD CONSTRAINT "contact_requests_not_self"
    CHECK ("sender_id" <> "recipient_id");
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_not_self"
    CHECK ("owner_id" <> "contact_id");
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_not_self"
    CHECK ("blocker_id" <> "blocked_id");
ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_not_self"
    CHECK ("reporter_id" IS NULL OR "reported_user_id" IS NULL OR "reporter_id" <> "reported_user_id");

-- A request is answered exactly when it leaves the PENDING state.
ALTER TABLE "contact_requests" ADD CONSTRAINT "contact_requests_response_consistent"
    CHECK (("status" = 'PENDING') = ("responded_at" IS NULL));

-- At most one pending request between two users, in either direction.
CREATE UNIQUE INDEX "contact_requests_one_pending_per_pair"
    ON "contact_requests" (LEAST("sender_id", "recipient_id"), GREATEST("sender_id", "recipient_id"))
    WHERE "status" = 'PENDING';

-- At most one open report per reporter, reported user and category.
CREATE UNIQUE INDEX "user_reports_one_open_per_category"
    ON "user_reports" ("reporter_id", "reported_user_id", "category")
    WHERE "status" = 'OPEN';
