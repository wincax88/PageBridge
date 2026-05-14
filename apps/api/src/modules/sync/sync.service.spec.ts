import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { SyncService } from "./sync.service";

function createService(latest: { id: string; createdAt: Date } | null) {
  const prisma = {
    syncChange: {
      findFirst: vi.fn().mockResolvedValue(latest),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({})
    },
    file: {
      findFirst: vi.fn().mockResolvedValue({ id: "file-1" })
    }
  };
  const redis = { limit: vi.fn().mockResolvedValue(undefined) };
  return { service: new SyncService(prisma as never, redis as never), prisma };
}

describe("SyncService.state", () => {
  it("returns the latest account cursor", async () => {
    const createdAt = new Date("2026-05-10T12:00:00.000Z");
    const { service, prisma } = createService({ id: "change-1", createdAt });

    await expect(service.state("user-1")).resolves.toEqual({
      latestChangeId: "change-1",
      cursor: "2026-05-10T12:00:00.000Z"
    });
    expect(prisma.syncChange.findFirst).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true }
    });
  });

  it("returns an epoch cursor when no changes exist", async () => {
    const { service } = createService(null);

    await expect(service.state("user-1")).resolves.toEqual({
      latestChangeId: null,
      cursor: "1970-01-01T00:00:00.000Z"
    });
  });
});

describe("SyncService.changes", () => {
  it("rejects invalid cursors", () => {
    const { service, prisma } = createService(null);

    expect(() => service.changes("user-1", "not-a-date")).toThrow(BadRequestException);
    expect(prisma.syncChange.findMany).not.toHaveBeenCalled();
  });
});

describe("SyncService.submit", () => {
  it("scopes idempotency to the current user", async () => {
    const { service, prisma } = createService(null);

    await service.submit("user-1", {
      entityType: "file",
      entityId: "file-1",
      operation: "update",
      clientRequestId: "request-1"
    });

    expect(prisma.syncChange.findUnique).toHaveBeenCalledWith({ where: { userId_clientRequestId: { userId: "user-1", clientRequestId: "request-1" } } });
  });

  it("rejects changes for files outside the current user", async () => {
    const { service, prisma } = createService(null);
    prisma.file.findFirst.mockResolvedValue(null);

    await expect(service.submit("user-1", {
      fileId: "file-2",
      entityType: "annotation",
      entityId: "annotation-1",
      operation: "update",
      clientRequestId: "request-2"
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.syncChange.create).not.toHaveBeenCalled();
  });
});
