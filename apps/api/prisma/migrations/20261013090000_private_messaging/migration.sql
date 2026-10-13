-- CreateEnum
CREATE TYPE "ConversationType" AS ENUM ('DIRECT');

-- CreateEnum
CREATE TYPE "AttachmentKind" AS ENUM ('IMAGE', 'VIDEO', 'AUDIO', 'VOICE', 'DOCUMENT', 'FILE');

-- CreateEnum
CREATE TYPE "PushProvider" AS ENUM ('EXPO', 'FCM', 'APNS');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEventType" ADD VALUE 'DEVICE_KEY_REGISTERED';
ALTER TYPE "AuditEventType" ADD VALUE 'DEVICE_KEY_REVOKED';
ALTER TYPE "AuditEventType" ADD VALUE 'CONVERSATION_CREATED';
ALTER TYPE "AuditEventType" ADD VALUE 'MESSAGE_DELETED_FOR_EVERYONE';

-- CreateTable
CREATE TABLE "device_keys" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "signature_public_key" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "device_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "key_packages" (
    "id" UUID NOT NULL,
    "device_key_id" UUID NOT NULL,
    "ref" CHAR(64) NOT NULL,
    "data" BYTEA NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "claimed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "key_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "type" "ConversationType" NOT NULL,
    "direct_key" VARCHAR(73),
    "version" BIGINT NOT NULL DEFAULT 0,
    "mls_epoch" BIGINT NOT NULL DEFAULT 0,
    "group_info" BYTEA,
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_participants" (
    "conversation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "last_read_seq" BIGINT NOT NULL DEFAULT 0,
    "last_delivered_seq" BIGINT NOT NULL DEFAULT 0,
    "read_at" TIMESTAMPTZ(3),
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_participants_pkey" PRIMARY KEY ("conversation_id","user_id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "version" BIGINT NOT NULL,
    "sender_id" UUID,
    "sender_device_key_id" UUID,
    "client_message_id" UUID NOT NULL,
    "epoch" BIGINT NOT NULL,
    "ciphertext" BYTEA,
    "reply_to_id" UUID,
    "forwarded" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "edited_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "withheld" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_edits" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "editor_device_key_id" UUID,
    "edited_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_edits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_reactions" (
    "message_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "reaction" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_reactions_pkey" PRIMARY KEY ("message_id","user_id","reaction")
);

-- CreateTable
CREATE TABLE "message_hides" (
    "user_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "version" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_hides_pkey" PRIMARY KEY ("user_id","message_id")
);

-- CreateTable
CREATE TABLE "mls_commits" (
    "conversation_id" UUID NOT NULL,
    "epoch" BIGINT NOT NULL,
    "version" BIGINT NOT NULL,
    "data" BYTEA NOT NULL,
    "sender_device_key_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mls_commits_pkey" PRIMARY KEY ("conversation_id","epoch")
);

-- CreateTable
CREATE TABLE "mls_welcomes" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "device_key_id" UUID NOT NULL,
    "epoch" BIGINT NOT NULL,
    "data" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mls_welcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "uploader_id" UUID,
    "message_id" UUID,
    "kind" "AttachmentKind" NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" BYTEA NOT NULL,
    "storage_key" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_tokens" (
    "device_id" UUID NOT NULL,
    "provider" "PushProvider" NOT NULL,
    "token" VARCHAR(512) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "push_tokens_pkey" PRIMARY KEY ("device_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "device_keys_signature_public_key_key" ON "device_keys"("signature_public_key");

-- CreateIndex
CREATE INDEX "device_keys_user_id_idx" ON "device_keys"("user_id");

-- CreateIndex
CREATE INDEX "device_keys_device_id_idx" ON "device_keys"("device_id");

-- CreateIndex
CREATE UNIQUE INDEX "key_packages_ref_key" ON "key_packages"("ref");

-- CreateIndex
CREATE INDEX "key_packages_device_key_id_claimed_at_idx" ON "key_packages"("device_key_id", "claimed_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_direct_key_key" ON "conversations"("direct_key");

-- CreateIndex
CREATE INDEX "conversations_updated_at_id_idx" ON "conversations"("updated_at", "id");

-- CreateIndex
CREATE INDEX "conversation_participants_user_id_conversation_id_idx" ON "conversation_participants"("user_id", "conversation_id");

-- CreateIndex
CREATE INDEX "messages_conversation_id_version_idx" ON "messages"("conversation_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversation_id_seq_key" ON "messages"("conversation_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversation_id_id_key" ON "messages"("conversation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_sender_id_client_message_id_key" ON "messages"("sender_id", "client_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_edits_message_id_revision_key" ON "message_edits"("message_id", "revision");

-- CreateIndex
CREATE INDEX "message_hides_user_id_conversation_id_version_idx" ON "message_hides"("user_id", "conversation_id", "version");

-- CreateIndex
CREATE INDEX "mls_commits_conversation_id_version_idx" ON "mls_commits"("conversation_id", "version");

-- CreateIndex
CREATE INDEX "mls_welcomes_device_key_id_id_idx" ON "mls_welcomes"("device_key_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "mls_welcomes_device_key_id_conversation_id_epoch_key" ON "mls_welcomes"("device_key_id", "conversation_id", "epoch");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_storage_key_key" ON "attachments"("storage_key");

-- CreateIndex
CREATE INDEX "attachments_message_id_idx" ON "attachments"("message_id");

-- CreateIndex
CREATE INDEX "attachments_uploader_id_created_at_idx" ON "attachments"("uploader_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "push_tokens_provider_token_key" ON "push_tokens"("provider", "token");

-- AddForeignKey
ALTER TABLE "device_keys" ADD CONSTRAINT "device_keys_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_keys" ADD CONSTRAINT "device_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "key_packages" ADD CONSTRAINT "key_packages_device_key_id_fkey" FOREIGN KEY ("device_key_id") REFERENCES "device_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_device_key_id_fkey" FOREIGN KEY ("sender_device_key_id") REFERENCES "device_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_reply_to_id_fkey" FOREIGN KEY ("conversation_id", "reply_to_id") REFERENCES "messages"("conversation_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "message_edits" ADD CONSTRAINT "message_edits_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_hides" ADD CONSTRAINT "message_hides_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_hides" ADD CONSTRAINT "message_hides_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_hides" ADD CONSTRAINT "message_hides_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mls_commits" ADD CONSTRAINT "mls_commits_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mls_welcomes" ADD CONSTRAINT "mls_welcomes_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mls_welcomes" ADD CONSTRAINT "mls_welcomes_device_key_id_fkey" FOREIGN KEY ("device_key_id") REFERENCES "device_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploader_id_fkey" FOREIGN KEY ("uploader_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ---------------------------------------------------------------------------
-- Integrity rules not expressible in the Prisma schema (see data-model.md).
-- ---------------------------------------------------------------------------

-- Device keys: Ed25519 public keys (32 bytes); at most one active key per device.
ALTER TABLE "device_keys" ADD CONSTRAINT "device_keys_signature_key_length"
    CHECK (octet_length("signature_public_key") = 32);
CREATE UNIQUE INDEX "device_keys_one_active_per_device"
    ON "device_keys" ("device_id") WHERE "revoked_at" IS NULL;

ALTER TABLE "key_packages" ADD CONSTRAINT "key_packages_ref_format"
    CHECK ("ref" ~ '^[0-9a-f]{64}$');
ALTER TABLE "key_packages" ADD CONSTRAINT "key_packages_size"
    CHECK (octet_length("data") BETWEEN 1 AND 4096);

-- A DIRECT conversation is identified by its (ordered) pair of users.
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_direct_key_consistent"
    CHECK (("type" = 'DIRECT') = ("direct_key" IS NOT NULL));
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_direct_key_format"
    CHECK ("direct_key" IS NULL OR (
        "direct_key" ~ '^[0-9a-f-]{36}:[0-9a-f-]{36}$'
        AND split_part("direct_key", ':', 1) < split_part("direct_key", ':', 2)));
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_counters_non_negative"
    CHECK ("version" >= 0 AND "mls_epoch" >= 0);
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_group_info_size"
    CHECK ("group_info" IS NULL OR octet_length("group_info") <= 262144);

ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_cursors"
    CHECK ("last_read_seq" >= 0 AND "last_delivered_seq" >= 0);

-- Participants of a DIRECT conversation can only be the two users named by its key.
CREATE FUNCTION ogc_check_direct_participant() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    pair TEXT;
BEGIN
    SELECT "direct_key" INTO pair FROM "conversations" WHERE "id" = NEW."conversation_id";
    IF pair IS NOT NULL
       AND NEW."user_id"::text <> split_part(pair, ':', 1)
       AND NEW."user_id"::text <> split_part(pair, ':', 2) THEN
        RAISE EXCEPTION 'user is not part of this direct conversation'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER "conversation_participants_direct_pair"
    BEFORE INSERT OR UPDATE ON "conversation_participants"
    FOR EACH ROW EXECUTE FUNCTION ogc_check_direct_participant();

-- Messages: deleted-for-everyone exactly when the ciphertext is gone; bounded ciphertext.
ALTER TABLE "messages" ADD CONSTRAINT "messages_deleted_consistent"
    CHECK (("deleted_at" IS NULL) = ("ciphertext" IS NOT NULL));
ALTER TABLE "messages" ADD CONSTRAINT "messages_ciphertext_size"
    CHECK ("ciphertext" IS NULL OR octet_length("ciphertext") <= 65536);
ALTER TABLE "messages" ADD CONSTRAINT "messages_ordering"
    CHECK ("seq" > 0 AND "version" >= "seq" AND "epoch" >= 0);
ALTER TABLE "messages" ADD CONSTRAINT "messages_edit_consistent"
    CHECK ("revision" >= 0 AND ("revision" = 0) = ("edited_at" IS NULL));
ALTER TABLE "messages" ADD CONSTRAINT "messages_not_reply_to_self"
    CHECK ("reply_to_id" IS NULL OR "reply_to_id" <> "id");

-- Reactions come from a fixed, controlled set.
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_allowed"
    CHECK ("reaction" IN ('thumbs_up', 'heart', 'joy', 'wow', 'sad', 'pray'));

ALTER TABLE "mls_commits" ADD CONSTRAINT "mls_commits_size"
    CHECK (octet_length("data") BETWEEN 1 AND 262144);
ALTER TABLE "mls_welcomes" ADD CONSTRAINT "mls_welcomes_size"
    CHECK (octet_length("data") BETWEEN 1 AND 262144);

-- Attachment keys are generated by the server only; sizes and digests are well-formed.
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_storage_key_format"
    CHECK ("storage_key" ~ '^attachments/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin$');
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_size_positive"
    CHECK ("size" > 0);
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_sha256_length"
    CHECK (octet_length("sha256") = 32);

ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_token_not_empty"
    CHECK (length("token") > 0);
