-- Add a monotonic cursor for sync pagination. This is intentionally staged so
-- existing rows can be backfilled before indexes/constraints are applied. On a
-- very large production table, run the UPDATE in batches before applying the
-- final constraint statements.
CREATE SEQUENCE IF NOT EXISTS "SyncChange_sequence_seq";

ALTER TABLE "SyncChange" ADD COLUMN IF NOT EXISTS "sequence" BIGINT;

UPDATE "SyncChange"
SET "sequence" = nextval('"SyncChange_sequence_seq"')
WHERE "sequence" IS NULL;

ALTER TABLE "SyncChange" ALTER COLUMN "sequence" SET DEFAULT nextval('"SyncChange_sequence_seq"');
ALTER TABLE "SyncChange" ALTER COLUMN "sequence" SET NOT NULL;
ALTER SEQUENCE "SyncChange_sequence_seq" OWNED BY "SyncChange"."sequence";

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "SyncChange_sequence_key" ON "SyncChange"("sequence");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "SyncChange_userId_sequence_idx" ON "SyncChange"("userId", "sequence");
