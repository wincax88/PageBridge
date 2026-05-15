-- Add a monotonic cursor for sync pagination. UUID ids are not ordered, so they
-- cannot safely break ties for same-timestamp changes.
ALTER TABLE "SyncChange" ADD COLUMN "sequence" BIGSERIAL NOT NULL;

CREATE UNIQUE INDEX "SyncChange_sequence_key" ON "SyncChange"("sequence");
CREATE INDEX "SyncChange_userId_sequence_idx" ON "SyncChange"("userId", "sequence");
