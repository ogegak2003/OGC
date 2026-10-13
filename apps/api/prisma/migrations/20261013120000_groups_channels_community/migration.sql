-- CreateEnum
CREATE TYPE "CommunityRole" AS ENUM ('OWNER', 'ADMIN', 'MODERATOR', 'MEMBER');

-- CreateEnum
CREATE TYPE "PostPolicy" AS ENUM ('ALL_MEMBERS', 'MODERATORS', 'ADMINS');

-- CreateEnum
CREATE TYPE "InvitePolicy" AS ENUM ('ALL_MEMBERS', 'ADMINS');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ConversationEventType" AS ENUM ('CREATED', 'MEMBER_JOINED', 'MEMBER_LEFT', 'MEMBER_REMOVED', 'ROLE_CHANGED', 'OWNERSHIP_TRANSFERRED', 'DETAILS_UPDATED', 'MESSAGE_REMOVED', 'ARCHIVED', 'UNARCHIVED');

-- CreateEnum
CREATE TYPE "NotificationLevel" AS ENUM ('ALL', 'MENTIONS', 'NONE');

-- CreateEnum
CREATE TYPE "ChannelVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "ChannelJoinPolicy" AS ENUM ('OPEN', 'APPROVAL');

-- CreateEnum
CREATE TYPE "ChannelMemberStatus" AS ENUM ('ACTIVE', 'PENDING', 'BANNED');

-- CreateEnum
CREATE TYPE "ModerationActionType" AS ENUM ('REMOVE_POST', 'RESTORE_POST', 'SUSPEND', 'UNSUSPEND', 'BAN', 'UNBAN', 'REMOVE_MEMBER', 'ROLE_CHANGED', 'APPROVE_MEMBER', 'REJECT_MEMBER', 'RESOLVE_REPORT', 'DISMISS_REPORT', 'PIN_POST', 'UNPIN_POST', 'VISIBILITY_CHANGED', 'OWNERSHIP_TRANSFERRED', 'ARCHIVED', 'UNARCHIVED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('GROUP_INVITATION', 'GROUP_MEMBER_ADDED', 'GROUP_MEMBER_REMOVED', 'GROUP_ROLE_CHANGED', 'GROUP_DETAILS_CHANGED', 'MENTION', 'CHANNEL_ANNOUNCEMENT', 'CHANNEL_ROLE_CHANGED', 'CHANNEL_JOIN_REQUEST', 'CHANNEL_REQUEST_APPROVED', 'CHANNEL_MEMBER_REMOVED', 'MODERATION_RESULT', 'INVITATION_EXPIRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEventType" ADD VALUE 'GROUP_CREATED';
ALTER TYPE "AuditEventType" ADD VALUE 'GROUP_MEMBER_REMOVED';
ALTER TYPE "AuditEventType" ADD VALUE 'GROUP_OWNERSHIP_TRANSFERRED';
ALTER TYPE "AuditEventType" ADD VALUE 'GROUP_DELETED';
ALTER TYPE "AuditEventType" ADD VALUE 'CHANNEL_CREATED';
ALTER TYPE "AuditEventType" ADD VALUE 'CHANNEL_OWNERSHIP_TRANSFERRED';
ALTER TYPE "AuditEventType" ADD VALUE 'CHANNEL_VISIBILITY_CHANGED';
ALTER TYPE "AuditEventType" ADD VALUE 'CHANNEL_DELETED';
ALTER TYPE "AuditEventType" ADD VALUE 'CHANNEL_MODERATION';
ALTER TYPE "AuditEventType" ADD VALUE 'INVITE_LINK_CREATED';
ALTER TYPE "AuditEventType" ADD VALUE 'INVITE_LINK_REVOKED';
ALTER TYPE "AuditEventType" ADD VALUE 'CONVERSATION_REPORTED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ConversationType" ADD VALUE 'GROUP';
ALTER TYPE "ConversationType" ADD VALUE 'CHANNEL';

-- AlterTable
ALTER TABLE "conversation_participants" ADD COLUMN     "muted_until" TIMESTAMPTZ(3),
ADD COLUMN     "notification_level" "NotificationLevel" NOT NULL DEFAULT 'ALL',
ADD COLUMN     "role" "CommunityRole" NOT NULL DEFAULT 'MEMBER';

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "mls_member_user_ids" UUID[] DEFAULT ARRAY[]::UUID[];

-- CreateTable
CREATE TABLE "group_profiles" (
    "conversation_id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "description" VARCHAR(500),
    "avatar_key" VARCHAR(128),
    "post_policy" "PostPolicy" NOT NULL DEFAULT 'ALL_MEMBERS',
    "invite_policy" "InvitePolicy" NOT NULL DEFAULT 'ADMINS',
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "group_profiles_pkey" PRIMARY KEY ("conversation_id")
);

-- CreateTable
CREATE TABLE "conversation_invitations" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "inviter_id" UUID,
    "invitee_id" UUID NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "responded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invite_links" (
    "id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "conversation_id" UUID,
    "channel_id" UUID,
    "created_by_id" UUID,
    "expires_at" TIMESTAMPTZ(3),
    "max_uses" INTEGER,
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invite_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_events" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "version" BIGINT NOT NULL,
    "type" "ConversationEventType" NOT NULL,
    "actor_id" UUID,
    "subject_id" UUID,
    "detail" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_reports" (
    "id" UUID NOT NULL,
    "reporter_id" UUID,
    "conversation_id" UUID,
    "message_id" UUID,
    "reported_user_id" UUID,
    "category" "ReportCategory" NOT NULL,
    "disclosed_text" VARCHAR(4000),
    "description" VARCHAR(1000),
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channels" (
    "id" UUID NOT NULL,
    "handle" VARCHAR(32) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "description" VARCHAR(1000),
    "avatar_key" VARCHAR(128),
    "visibility" "ChannelVisibility" NOT NULL DEFAULT 'PUBLIC',
    "join_policy" "ChannelJoinPolicy" NOT NULL DEFAULT 'OPEN',
    "post_policy" "PostPolicy" NOT NULL DEFAULT 'ADMINS',
    "replies_enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" BIGINT NOT NULL DEFAULT 0,
    "member_count" INTEGER NOT NULL DEFAULT 0,
    "last_post_at" TIMESTAMPTZ(3),
    "archived_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_members" (
    "channel_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "CommunityRole" NOT NULL DEFAULT 'MEMBER',
    "status" "ChannelMemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "suspended_until" TIMESTAMPTZ(3),
    "notification_level" "NotificationLevel" NOT NULL DEFAULT 'ALL',
    "muted_until" TIMESTAMPTZ(3),
    "last_read_seq" BIGINT NOT NULL DEFAULT 0,
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_members_pkey" PRIMARY KEY ("channel_id","user_id")
);

-- CreateTable
CREATE TABLE "channel_posts" (
    "id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "version" BIGINT NOT NULL,
    "author_id" UUID,
    "client_post_id" UUID NOT NULL,
    "body" VARCHAR(4000),
    "reply_to_id" UUID,
    "announcement" BOOLEAN NOT NULL DEFAULT false,
    "pinned_at" TIMESTAMPTZ(3),
    "edited_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "removed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_post_reactions" (
    "post_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "reaction" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_post_reactions_pkey" PRIMARY KEY ("post_id","user_id","reaction")
);

-- CreateTable
CREATE TABLE "channel_attachments" (
    "id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "uploader_id" UUID,
    "post_id" UUID,
    "kind" "AttachmentKind" NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "mime" VARCHAR(127) NOT NULL,
    "size" INTEGER NOT NULL,
    "storage_key" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_moderation_actions" (
    "id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "moderator_id" UUID,
    "action" "ModerationActionType" NOT NULL,
    "target_user_id" UUID,
    "target_post_id" UUID,
    "reason" VARCHAR(500),
    "until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_moderation_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_post_reports" (
    "id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "reporter_id" UUID,
    "category" "ReportCategory" NOT NULL,
    "description" VARCHAR(1000),
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" VARCHAR(500),
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_post_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "dedupe_key" VARCHAR(200) NOT NULL,
    "data" JSONB NOT NULL,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "group_profiles_avatar_key_key" ON "group_profiles"("avatar_key");

-- CreateIndex
CREATE INDEX "conversation_invitations_invitee_id_status_id_idx" ON "conversation_invitations"("invitee_id", "status", "id");

-- CreateIndex
CREATE INDEX "conversation_invitations_conversation_id_status_idx" ON "conversation_invitations"("conversation_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "invite_links_token_hash_key" ON "invite_links"("token_hash");

-- CreateIndex
CREATE INDEX "invite_links_conversation_id_created_at_idx" ON "invite_links"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "invite_links_channel_id_created_at_idx" ON "invite_links"("channel_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_events_conversation_id_version_key" ON "conversation_events"("conversation_id", "version");

-- CreateIndex
CREATE INDEX "conversation_reports_status_id_idx" ON "conversation_reports"("status", "id");

-- CreateIndex
CREATE INDEX "conversation_reports_reporter_id_created_at_idx" ON "conversation_reports"("reporter_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "channels_handle_key" ON "channels"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "channels_avatar_key_key" ON "channels"("avatar_key");

-- CreateIndex
CREATE INDEX "channels_visibility_member_count_idx" ON "channels"("visibility", "member_count");

-- CreateIndex
CREATE INDEX "channel_members_user_id_status_idx" ON "channel_members"("user_id", "status");

-- CreateIndex
CREATE INDEX "channel_members_channel_id_status_role_idx" ON "channel_members"("channel_id", "status", "role");

-- CreateIndex
CREATE INDEX "channel_posts_channel_id_version_idx" ON "channel_posts"("channel_id", "version");

-- CreateIndex
CREATE INDEX "channel_posts_channel_id_pinned_at_idx" ON "channel_posts"("channel_id", "pinned_at");

-- CreateIndex
CREATE UNIQUE INDEX "channel_posts_channel_id_seq_key" ON "channel_posts"("channel_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "channel_posts_channel_id_id_key" ON "channel_posts"("channel_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_posts_author_id_client_post_id_key" ON "channel_posts"("author_id", "client_post_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_attachments_storage_key_key" ON "channel_attachments"("storage_key");

-- CreateIndex
CREATE INDEX "channel_attachments_post_id_idx" ON "channel_attachments"("post_id");

-- CreateIndex
CREATE INDEX "channel_attachments_post_id_created_at_idx" ON "channel_attachments"("post_id", "created_at");

-- CreateIndex
CREATE INDEX "channel_moderation_actions_channel_id_id_idx" ON "channel_moderation_actions"("channel_id", "id");

-- CreateIndex
CREATE INDEX "channel_post_reports_channel_id_status_id_idx" ON "channel_post_reports"("channel_id", "status", "id");

-- CreateIndex
CREATE INDEX "notifications_user_id_id_idx" ON "notifications"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_dedupe_key_key" ON "notifications"("user_id", "dedupe_key");

-- AddForeignKey
ALTER TABLE "group_profiles" ADD CONSTRAINT "group_profiles_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_invitations" ADD CONSTRAINT "conversation_invitations_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_invitations" ADD CONSTRAINT "conversation_invitations_inviter_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_invitations" ADD CONSTRAINT "conversation_invitations_invitee_id_fkey" FOREIGN KEY ("invitee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_links" ADD CONSTRAINT "invite_links_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_links" ADD CONSTRAINT "invite_links_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_links" ADD CONSTRAINT "invite_links_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_reports" ADD CONSTRAINT "conversation_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_reports" ADD CONSTRAINT "conversation_reports_reported_user_id_fkey" FOREIGN KEY ("reported_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_reports" ADD CONSTRAINT "conversation_reports_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_posts" ADD CONSTRAINT "channel_posts_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_posts" ADD CONSTRAINT "channel_posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_posts" ADD CONSTRAINT "channel_posts_channel_id_reply_to_id_fkey" FOREIGN KEY ("channel_id", "reply_to_id") REFERENCES "channel_posts"("channel_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "channel_post_reactions" ADD CONSTRAINT "channel_post_reactions_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "channel_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_post_reactions" ADD CONSTRAINT "channel_post_reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_attachments" ADD CONSTRAINT "channel_attachments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "channel_posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_moderation_actions" ADD CONSTRAINT "channel_moderation_actions_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_post_reports" ADD CONSTRAINT "channel_post_reports_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_post_reports" ADD CONSTRAINT "channel_post_reports_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "channel_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ---------------------------------------------------------------------------
-- Integrity rules not expressible in the Prisma schema (see data-model.md).
-- ---------------------------------------------------------------------------

-- Exactly one owner at most per group/channel (ownership moves only by transfer).
CREATE UNIQUE INDEX "conversation_participants_one_owner"
    ON "conversation_participants" ("conversation_id") WHERE "role" = 'OWNER';
CREATE UNIQUE INDEX "channel_members_one_owner"
    ON "channel_members" ("channel_id") WHERE "role" = 'OWNER';

-- Group settings exist only for GROUP and CHANNEL conversations; names are never blank.
ALTER TABLE "group_profiles" ADD CONSTRAINT "group_profiles_name_not_blank"
    CHECK (length(btrim("name")) > 0);
ALTER TABLE "group_profiles" ADD CONSTRAINT "group_profiles_avatar_key_format"
    CHECK ("avatar_key" IS NULL OR "avatar_key" ~ '^avatars/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$');

-- One pending personal invitation per conversation and invitee; invitations name two people.
CREATE UNIQUE INDEX "conversation_invitations_one_pending"
    ON "conversation_invitations" ("conversation_id", "invitee_id") WHERE "status" = 'PENDING';
ALTER TABLE "conversation_invitations" ADD CONSTRAINT "conversation_invitations_not_self"
    CHECK ("inviter_id" IS NULL OR "inviter_id" <> "invitee_id");
ALTER TABLE "conversation_invitations" ADD CONSTRAINT "conversation_invitations_response_consistent"
    CHECK (("status" = 'PENDING') = ("responded_at" IS NULL));

-- Invitation links target exactly one community and respect their use limit.
ALTER TABLE "invite_links" ADD CONSTRAINT "invite_links_one_target"
    CHECK (num_nonnulls("conversation_id", "channel_id") = 1);
ALTER TABLE "invite_links" ADD CONSTRAINT "invite_links_uses"
    CHECK ("use_count" >= 0 AND ("max_uses" IS NULL OR ("max_uses" > 0 AND "use_count" <= "max_uses")));
ALTER TABLE "invite_links" ADD CONSTRAINT "invite_links_token_hash_format"
    CHECK ("token_hash" ~ '^[0-9a-f]{64}$');

-- Community channels.
ALTER TABLE "channels" ADD CONSTRAINT "channels_handle_format"
    CHECK ("handle" ~ '^[a-z][a-z0-9_]{4,31}$');
ALTER TABLE "channels" ADD CONSTRAINT "channels_name_not_blank"
    CHECK (length(btrim("name")) > 0);
ALTER TABLE "channels" ADD CONSTRAINT "channels_avatar_key_format"
    CHECK ("avatar_key" IS NULL OR "avatar_key" ~ '^avatars/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$');
ALTER TABLE "channels" ADD CONSTRAINT "channels_counters_non_negative"
    CHECK ("version" >= 0 AND "member_count" >= 0);

ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_cursor"
    CHECK ("last_read_seq" >= 0);
-- Only active members hold staff roles.
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_role_requires_active"
    CHECK ("role" = 'MEMBER' OR "status" = 'ACTIVE');

ALTER TABLE "channel_posts" ADD CONSTRAINT "channel_posts_ordering"
    CHECK ("seq" > 0 AND "version" >= "seq");
-- A deleted post keeps no text; a live post has text or attachments (checked by the API).
ALTER TABLE "channel_posts" ADD CONSTRAINT "channel_posts_deleted_has_no_body"
    CHECK ("deleted_at" IS NULL OR "body" IS NULL);
ALTER TABLE "channel_posts" ADD CONSTRAINT "channel_posts_not_reply_to_self"
    CHECK ("reply_to_id" IS NULL OR "reply_to_id" <> "id");

ALTER TABLE "channel_post_reactions" ADD CONSTRAINT "channel_post_reactions_allowed"
    CHECK ("reaction" IN ('thumbs_up', 'heart', 'joy', 'wow', 'sad', 'pray'));

ALTER TABLE "channel_attachments" ADD CONSTRAINT "channel_attachments_storage_key_format"
    CHECK ("storage_key" ~ '^channel-media/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|bin)$');
ALTER TABLE "channel_attachments" ADD CONSTRAINT "channel_attachments_size_positive"
    CHECK ("size" > 0);

-- Channel discovery: trigram search over public metadata only.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "channels_search_trgm"
    ON "channels" USING gin ((lower("name" || ' ' || "handle" || ' ' || coalesce("description", ''))) gin_trgm_ops)
    WHERE "visibility" = 'PUBLIC' AND "archived_at" IS NULL;
