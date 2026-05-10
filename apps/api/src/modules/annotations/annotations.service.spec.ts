import { ConflictException } from "@nestjs/common";
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
      update: vi.fn().mockImplementation(({ data }) => Promise.resolve({ ...currentAnnotation, ...data, version: currentAnnotation.version + 1 }))
    },
    syncChange: { create: vi.fn().mockResolvedValue({}) }
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

    expect(prisma.annotation.update).toHaveBeenCalledWith({
      where: { id: "annotation-1" },
      data: { note: "new note", version: { increment: 1 } }
    });
    expect(updated.version).toBe(4);
  });
});
