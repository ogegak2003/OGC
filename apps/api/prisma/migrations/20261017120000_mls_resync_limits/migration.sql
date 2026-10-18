-- MLS resync limits. Additive: existing commits get resync = false (they are not resyncs) and
-- keep working unchanged. The index serves the rolling-window counts of a device's resyncs.
-- On a large mls_commits table, consider creating the index CONCURRENTLY ahead of deploying.
-- AlterTable
ALTER TABLE "mls_commits" ADD COLUMN     "resync" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "mls_commits_sender_device_key_id_resync_created_at_idx" ON "mls_commits"("sender_device_key_id", "resync", "created_at");
