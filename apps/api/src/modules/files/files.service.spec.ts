import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { FilesService } from "./files.service";

function createService(overrides: { contentLength?: number; contentType?: string } = {}) {
  const prisma = {
    file: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { sizeBytes: BigInt(0) }, _count: { id: 0 } }),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ ...data, pageCount: null, deletedAt: null, createdAt: new Date(), updatedAt: new Date() })),
      findMany: vi.fn().mockResolvedValue([])
    },
    syncChange: { create: vi.fn().mockResolvedValue({}) }
  };
  const redis = { limit: vi.fn().mockResolvedValue(undefined) };
  const storage = {
    buildUserFileKey: vi.fn((userId: string, fileId: string) => `users/${userId}/files/${fileId}.pdf`),
    getObjectMetadata: vi.fn().mockResolvedValue({ ContentLength: overrides.contentLength ?? 1234, ContentType: overrides.contentType ?? "application/pdf" })
  };

  return {
    service: new FilesService(prisma as never, redis as never, storage as never),
    prisma,
    storage
  };
}

describe("FilesService.completeUpload", () => {
  it("creates the file only after verifying the uploaded object", async () => {
    const { service, prisma, storage } = createService();

    const file = await service.completeUpload("user-1", {
      fileId: "file-1",
      name: "paper.pdf",
      sizeBytes: 1234,
      storageKey: "users/user-1/files/file-1.pdf"
    });

    expect(storage.getObjectMetadata).toHaveBeenCalledWith("users/user-1/files/file-1.pdf");
    expect(prisma.file.create).toHaveBeenCalled();
    expect(file.sizeBytes).toBe("1234");
  });

  it("rejects storage keys that do not match the upload target", async () => {
    const { service, prisma } = createService();

    await expect(service.completeUpload("user-1", {
      fileId: "file-1",
      name: "paper.pdf",
      sizeBytes: 1234,
      storageKey: "users/user-1/files/other.pdf"
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.file.create).not.toHaveBeenCalled();
  });

  it("rejects uploaded objects whose size does not match", async () => {
    const { service, prisma } = createService({ contentLength: 999 });

    await expect(service.completeUpload("user-1", {
      fileId: "file-1",
      name: "paper.pdf",
      sizeBytes: 1234,
      storageKey: "users/user-1/files/file-1.pdf"
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.file.create).not.toHaveBeenCalled();
  });
});
