-- Add a monotonic cursor for sync pagination. The default is set before the
-- backfill so rows created during deployment receive a sequence immediately.
CREATE SEQUENCE IF NOT EXISTS "SyncChange_sequence_seq";

ALTER TABLE "SyncChange" ADD COLUMN IF NOT EXISTS "sequence" BIGINT;
ALTER TABLE "SyncChange" ALTER COLUMN "sequence" SET DEFAULT nextval('"SyncChange_sequence_seq"');

UPDATE "SyncChange"
SET "sequence" = nextval('"SyncChange_sequence_seq"')
WHERE "sequence" IS NULL;

ALTER TABLE "SyncChange" ALTER COLUMN "sequence" SET NOT NULL;
ALTER SEQUENCE "SyncChange_sequence_seq" OWNED BY "SyncChange"."sequence";

CREATE UNIQUE INDEX IF NOT EXISTS "SyncChange_sequence_key" ON "SyncChange"("sequence");
CREATE INDEX IF NOT EXISTS "SyncChange_userId_sequence_idx" ON "SyncChange"("userId", "sequence");
