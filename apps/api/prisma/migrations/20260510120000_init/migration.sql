-- CreateEnum
CREATE TYPE "AnnotationType" AS ENUM ('highlight', 'text_note');

-- CreateEnum
CREATE TYPE "ChangeEntityType" AS ENUM ('file', 'annotation', 'reading_progress');

-- CreateEnum
CREATE TYPE "ChangeOperation" AS ENUM ('create', 'update', 'delete');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "File" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/pdf',
    "storageKey" TEXT NOT NULL,
    "checksum" TEXT,
    "pageCount" INTEGER,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "File_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Annotation" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT,
    "type" "AnnotationType" NOT NULL,
    "page" INTEGER NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#FFE066',
    "opacity" DOUBLE PRECISION NOT NULL DEFAULT 0.45,
    "text" TEXT,
    "note" TEXT,
    "quadPoints" JSONB,
    "rect" JSONB,
    "pageWidth" DOUBLE PRECISION,
    "pageHeight" DOUBLE PRECISION,
    "pageRotation" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Annotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReadingProgress" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "page" INTEGER NOT NULL DEFAULT 1,
    "scrollOffset" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "zoomMode" TEXT NOT NULL DEFAULT 'fit_width',
    "zoomValue" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReadingProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncChange" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fileId" TEXT,
    "entityType" "ChangeEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "operation" "ChangeOperation" NOT NULL,
    "baseVersion" INTEGER,
    "nextVersion" INTEGER,
    "clientRequestId" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "File_userId_deletedAt_idx" ON "File"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "Annotation_fileId_page_deletedAt_idx" ON "Annotation"("fileId", "page", "deletedAt");

-- CreateIndex
CREATE INDEX "Annotation_userId_updatedAt_idx" ON "Annotation"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReadingProgress_fileId_userId_deviceId_key" ON "ReadingProgress"("fileId", "userId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "SyncChange_clientRequestId_key" ON "SyncChange"("clientRequestId");

-- CreateIndex
CREATE INDEX "SyncChange_userId_createdAt_idx" ON "SyncChange"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SyncChange_fileId_createdAt_idx" ON "SyncChange"("fileId", "createdAt");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "File" ADD CONSTRAINT "File_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Annotation" ADD CONSTRAINT "Annotation_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Annotation" ADD CONSTRAINT "Annotation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReadingProgress" ADD CONSTRAINT "ReadingProgress_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReadingProgress" ADD CONSTRAINT "ReadingProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncChange" ADD CONSTRAINT "SyncChange_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncChange" ADD CONSTRAINT "SyncChange_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;
