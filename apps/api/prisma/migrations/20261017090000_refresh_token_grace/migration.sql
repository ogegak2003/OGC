-- Refresh-token grace window. Additive: existing sessions keep working unchanged. The array
-- default backfills existing rows with '{}', and a NULL rotation time means "no grace window
-- open", so a session's first refresh after deploy behaves exactly as before.
-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "refresh_rotated_at" TIMESTAMPTZ(3),
ADD COLUMN     "superseded_refresh_token_hashes" TEXT[] DEFAULT ARRAY[]::TEXT[];
