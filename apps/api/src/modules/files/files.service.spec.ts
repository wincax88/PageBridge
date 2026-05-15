import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { FilesService } from "./files.service";

interface FileFixture {
  id: string;
  userId: string;
  name: string;
  sizeBytes: bigint;
  mimeType: string;
  storageKey: string;
  pageCount: number | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const deletedFile: FileFixture = {
  id: "file-1",
  userId: "user-1",
  name: "paper.pdf",
  sizeBytes: BigInt(1234),
  mimeType: "application/pdf",
  storageKey: "users/user-1/files/file-1.pdf",
  pageCount: null,
  deletedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date()
};

function createService(overrides: {
  contentLength?: number;
  contentType?: string;
  pdfHeader?: Buffer;
  fileCount?: number;
  usedBytes?: bigint;
  deletedFiles?: Array<{ id: string; storageKey: string }>;
  deleteObject?: ReturnType<typeof vi.fn>;
  existingFile?: FileFixture | null;
  activeFile?: FileFixture | null;
} = {}) {
  const prisma = {
    file: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { sizeBytes: overrides.usedBytes ?? BigInt(0) }, _count: { id: 0 } }),
      count: vi.fn().mockResolvedValue(overrides.fileCount ?? 0),
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ ...data, pageCount: null, deletedAt: null, createdAt: new Date(), updatedAt: new Date() })),
      findFirst: vi.fn().mockImplementation(({ where }) => {
        const hasDeletedAtFilter = Object.prototype.hasOwnProperty.call(where, "deletedAt");
        if (where.id === "file-1" && where.userId === "user-1" && !hasDeletedAtFilter) return Promise.resolve(overrides.existingFile ?? overrides.activeFile ?? null);
        if (where.id === "file-1" && where.userId === "user-1") return Promise.resolve(overrides.activeFile ?? deletedFile);
        return Promise.resolve(deletedFile);
      }),
      findMany: vi.fn().mockResolvedValue(overrides.deletedFiles ?? []),
      update: vi.fn().mockResolvedValue({ ...deletedFile, deletedAt: null }),
      delete: vi.fn().mockResolvedValue(deletedFile)
    },
    syncChange: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn((callback) => callback(prisma))
  };
  const redis = { limit: vi.fn().mockResolvedValue(undefined) };
  const storage = {
    buildUserFileKey: vi.fn((userId: string, fileId: string) => `users/${userId}/files/${fileId}.pdf`),
    putPdf: vi.fn().mockResolvedValue(undefined),
    getObjectMetadata: vi.fn().mockResolvedValue({ ContentLength: overrides.contentLength ?? 1234, ContentType: overrides.contentType ?? "application/pdf" }),
    getObjectPrefix: vi.fn().mockResolvedValue(overrides.pdfHeader ?? Buffer.from("%PDF-")),
    deleteObject: overrides.deleteObject ?? vi.fn().mockResolvedValue(undefined)
  };

  return {
    service: new FilesService(prisma as never, redis as never, storage as never),
    prisma,
    storage
  };
}

describe("FilesService.upload", () => {
  it("creates uploaded files inside the quota transaction", async () => {
    const { service, prisma, storage } = createService();

    await service.upload("user-1", {
      originalname: "paper.pdf",
      mimetype: "application/pdf",
      size: 1234,
      buffer: Buffer.from("%PDF-file")
    } as Express.Multer.File);

    expect(storage.putPdf).toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.file.create).toHaveBeenCalled();
    expect(prisma.syncChange.create).toHaveBeenCalled();
  });

  it("rejects multipart uploads without a PDF header", async () => {
    const { service, prisma, storage } = createService();

    await expect(service.upload("user-1", {
      originalname: "paper.pdf",
      mimetype: "application/pdf",
      size: 1234,
      buffer: Buffer.from("nope")
    } as Express.Multer.File)).rejects.toBeInstanceOf(BadRequestException);

    expect(storage.putPdf).not.toHaveBeenCalled();
    expect(prisma.file.create).not.toHaveBeenCalled();
  });
});

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
    expect(storage.getObjectPrefix).toHaveBeenCalledWith("users/user-1/files/file-1.pdf", 5);
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

  it("rejects uploaded objects without a PDF header", async () => {
    const { service, prisma } = createService({ pdfHeader: Buffer.from("nope") });

    await expect(service.completeUpload("user-1", {
      fileId: "file-1",
      name: "paper.pdf",
      sizeBytes: 1234,
      storageKey: "users/user-1/files/file-1.pdf"
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.file.create).not.toHaveBeenCalled();
  });

  it("returns an existing completed upload when the client retries", async () => {
    const { service, prisma } = createService({ existingFile: deletedFile });

    const file = await service.completeUpload("user-1", {
      fileId: "file-1",
      name: "paper.pdf",
      sizeBytes: 1234,
      storageKey: "users/user-1/files/file-1.pdf"
    });

    expect(prisma.file.create).not.toHaveBeenCalled();
    expect(file.sizeBytes).toBe("1234");
  });

  it("retries serialization conflicts during completion", async () => {
    const { service, prisma } = createService();
    const serializationError = new Prisma.PrismaClientKnownRequestError("serialization", { code: "P2034", clientVersion: "test" });
    prisma.$transaction.mockRejectedValueOnce(serializationError).mockImplementation((callback) => callback(prisma));

    await expect(service.completeUpload("user-1", {
      fileId: "file-1",
      name: "paper.pdf",
      sizeBytes: 1234,
      storageKey: "users/user-1/files/file-1.pdf"
    })).resolves.toMatchObject({ id: "file-1", sizeBytes: "1234" });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });
});

describe("FilesService trash operations", () => {
  it("treats repeated soft deletes as idempotent", async () => {
    const alreadyDeleted = { ...deletedFile, deletedAt: new Date() };
    const { service, prisma } = createService({ activeFile: alreadyDeleted });

    await expect(service.softDelete("user-1", "file-1")).resolves.toMatchObject({ id: "file-1", sizeBytes: "1234" });

    expect(prisma.file.update).not.toHaveBeenCalled();
    expect(prisma.syncChange.create).not.toHaveBeenCalled();
  });

  it("checks storage quota before restoring a deleted file", async () => {
    const { service, prisma } = createService({ usedBytes: BigInt(1024 * 1024 * 1024) });

    await expect(service.restore("user-1", "file-1")).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.file.update).not.toHaveBeenCalled();
  });

  it("deletes the database row even when the stored object is already missing", async () => {
    const deleteObject = vi.fn().mockRejectedValue(new Error("missing object"));
    const { service, prisma, storage } = createService({ deleteObject });

    await expect(service.permanentlyDelete("user-1", "file-1")).resolves.toEqual({ ok: true });

    expect(storage.deleteObject).toHaveBeenCalledWith("users/user-1/files/file-1.pdf");
    expect(prisma.file.delete).toHaveBeenCalledWith({ where: { id: "file-1" } });
  });

  it("deletes every trashed file when emptying trash", async () => {
    const { service, prisma, storage } = createService({
      deletedFiles: [
        { id: "file-1", storageKey: "users/user-1/files/file-1.pdf" },
        { id: "file-2", storageKey: "users/user-1/files/file-2.pdf" }
      ]
    });

    await expect(service.emptyTrash("user-1")).resolves.toEqual({ ok: true, deletedCount: 2 });

    expect(storage.deleteObject).toHaveBeenCalledTimes(2);
    expect(prisma.file.delete).toHaveBeenCalledWith({ where: { id: "file-1" } });
    expect(prisma.file.delete).toHaveBeenCalledWith({ where: { id: "file-2" } });
  });
});

describe("FilesService update operations", () => {
  it("does not record a rename change when the name is unchanged", async () => {
    const { service, prisma } = createService({ activeFile: { ...deletedFile, deletedAt: null } });

    await expect(service.rename("user-1", "file-1", "paper.pdf")).resolves.toMatchObject({ id: "file-1", name: "paper.pdf" });

    expect(prisma.file.update).not.toHaveBeenCalled();
    expect(prisma.syncChange.create).not.toHaveBeenCalled();
  });

  it("does not record a page count change when the value is unchanged", async () => {
    const { service, prisma } = createService({ activeFile: { ...deletedFile, pageCount: 12, deletedAt: null } });

    await expect(service.updatePageCount("user-1", "file-1", 12)).resolves.toMatchObject({ id: "file-1", pageCount: 12 });

    expect(prisma.file.update).not.toHaveBeenCalled();
    expect(prisma.syncChange.create).not.toHaveBeenCalled();
  });
});
