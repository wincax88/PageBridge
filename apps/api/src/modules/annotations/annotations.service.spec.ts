import { BadRequestException, ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { AnnotationsService } from "./annotations.service";

function createService() {
  const currentAnnotation = {
    id: "annotation-1",
    fileId: "file-1",
    userId: "user-1",
    type: "highlight",
    page: 1,
    color: "#FFE066",
    text: "selected text",
    note: null,
    version: 3,
    deletedAt: null,
    updatedAt: new Date()
  };
  const prisma = {
    file: { findFirst: vi.fn().mockResolvedValue({ id: "file-1", userId: "user-1" }) },
    annotation: {
      findFirst: vi.fn().mockResolvedValue(currentAnnotation),
      create: vi.fn().mockResolvedValue(currentAnnotation),
      update: vi.fn().mockImplementation(({ data }) => Promise.resolve({ ...currentAnnotation, ...data, version: currentAnnotation.version + 1 })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    syncChange: {
      create: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(null)
    },
    $transaction: vi.fn((callback) => callback(prisma))
  };

  return {
    service: new AnnotationsService(prisma as never),
    prisma
  };
}

describe("AnnotationsService.update", () => {
  it("rejects stale annotation edits", async () => {
    const { service, prisma } = createService();

    await expect(service.update("user-1", "file-1", "annotation-1", { note: "new note", baseVersion: 2 })).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.annotation.update).not.toHaveBeenCalled();
  });

  it("updates when the base version matches", async () => {
    const { service, prisma } = createService();

    const updated = await service.update("user-1", "file-1", "annotation-1", { note: "new note", baseVersion: 3 });

    expect(prisma.annotation.updateMany).toHaveBeenCalledWith({
      where: { id: "annotation-1", userId: "user-1", fileId: "file-1", deletedAt: null, version: 3 },
      data: { note: "new note", version: { increment: 1 } }
    });
    expect(updated.version).toBe(3);
  });

  it("rejects concurrent edits that lose the atomic version check", async () => {
    const { service, prisma } = createService();
    prisma.annotation.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.update("user-1", "file-1", "annotation-1", { note: "new note", baseVersion: 3 })).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.syncChange.create).not.toHaveBeenCalled();
  });
});

describe("AnnotationsService.create", () => {
  it("returns the existing annotation for a repeated client request", async () => {
    const { service, prisma } = createService();
    prisma.syncChange.findUnique.mockResolvedValue({
      entityType: "annotation",
      operation: "create",
      fileId: "file-1",
      entityId: "annotation-1"
    });

    const annotation = await service.create("user-1", "file-1", {
      type: "highlight",
      page: 1,
      text: "selected text",
      quadPoints: [{ x: 1, y: 1, width: 10, height: 10 }],
      clientRequestId: "request-1"
    });

    expect(prisma.annotation.create).not.toHaveBeenCalled();
    expect(annotation.id).toBe("annotation-1");
  });

  it("uses the client request id as the annotation id", async () => {
    const { service, prisma } = createService();

    await service.create("user-1", "file-1", {
      type: "highlight",
      page: 1,
      text: "selected text",
      quadPoints: [{ x: 1, y: 1, width: 10, height: 10 }],
      clientRequestId: "request-1"
    });

    expect(prisma.annotation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ id: "request-1" })
    }));
    expect(prisma.syncChange.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ clientRequestId: "request-1" })
    }));
  });

  it("returns the existing annotation when concurrent creates race", async () => {
    const { service, prisma } = createService();
    prisma.annotation.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" }));

    const annotation = await service.create("user-1", "file-1", {
      type: "highlight",
      page: 1,
      text: "selected text",
      quadPoints: [{ x: 1, y: 1, width: 10, height: 10 }],
      clientRequestId: "annotation-1"
    });

    expect(annotation.id).toBe("annotation-1");
  });

  it("rejects blank client request ids", async () => {
    const { service, prisma } = createService();

    await expect(service.create("user-1", "file-1", {
      type: "highlight",
      page: 1,
      text: "selected text",
      quadPoints: [{ x: 1, y: 1, width: 10, height: 10 }],
      clientRequestId: " "
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.annotation.create).not.toHaveBeenCalled();
  });

  it("treats duplicate sync changes as an idempotent create", async () => {
    const { service, prisma } = createService();
    prisma.annotation.create.mockResolvedValue({
      id: "request-1",
      fileId: "file-1",
      userId: "user-1",
      type: "highlight",
      page: 1,
      color: "#FFE066",
      text: "selected text",
      note: null,
      version: 1,
      deletedAt: null,
      updatedAt: new Date()
    });
    prisma.syncChange.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" }));
    prisma.syncChange.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        entityType: "annotation",
        operation: "create",
        fileId: "file-1",
        entityId: "request-1"
      });

    await expect(service.create("user-1", "file-1", {
      type: "highlight",
      page: 1,
      text: "selected text",
      quadPoints: [{ x: 1, y: 1, width: 10, height: 10 }],
      clientRequestId: "request-1"
    })).resolves.toMatchObject({ id: "request-1" });
  });
});
