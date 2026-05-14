-- DropIndex
DROP INDEX "SyncChange_clientRequestId_key";

-- CreateIndex
CREATE UNIQUE INDEX "SyncChange_userId_clientRequestId_key" ON "SyncChange"("userId", "clientRequestId");
