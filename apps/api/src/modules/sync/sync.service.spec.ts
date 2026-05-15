import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { SyncService } from "./sync.service";

function createService(latest: { id: string; createdAt: Date; sequence: bigint } | null) {
  const prisma = {
    syncChange: {
      findFirst: vi.fn().mockResolvedValue(latest),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "change-created", sequence: BigInt(3) })
    },
    file: {
      findFirst: vi.fn().mockResolvedValue({ id: "file-1" })
    },
    annotation: {
      findFirst: vi.fn().mockResolvedValue({ id: "annotation-1" })
    },
    readingProgress: {
      findFirst: vi.fn().mockResolvedValue({ id: "progress-1" })
    }
  };
  const redis = { limit: vi.fn().mockResolvedValue(undefined) };
  return { service: new SyncService(prisma as never, redis as never), prisma };
}

describe("SyncService.state", () => {
  it("returns the latest account cursor", async () => {
    const createdAt = new Date("2026-05-10T12:00:00.000Z");
    const { service, prisma } = createService({ id: "change-1", createdAt, sequence: BigInt(2) });

    await expect(service.state("user-1")).resolves.toEqual({
      latestChangeId: "change-1",
      cursor: Buffer.from(JSON.stringify({ createdAt: "2026-05-10T12:00:00.000Z", id: "change-1", sequence: "2" }), "utf8").toString("base64url")
    });
    expect(prisma.syncChange.findFirst).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      orderBy: { sequence: "desc" },
      select: { id: true, createdAt: true, sequence: true }
    });
  });

  it("returns an epoch cursor when no changes exist", async () => {
    const { service } = createService(null);

    await expect(service.state("user-1")).resolves.toEqual({
      latestChangeId: null,
      cursor: Buffer.from(JSON.stringify({ createdAt: "1970-01-01T00:00:00.000Z", id: "", sequence: "0" }), "utf8").toString("base64url")
    });
  });
});

describe("SyncService.changes", () => {
  it("rejects invalid cursors", () => {
    const { service, prisma } = createService(null);

    expect(() => service.changes("user-1", "not-a-date")).toThrow(BadRequestException);
    expect(prisma.syncChange.findMany).not.toHaveBeenCalled();
  });

  it("uses a stable compound cursor to avoid skipping same-timestamp changes", () => {
    const { service, prisma } = createService(null);
    const cursor = Buffer.from(JSON.stringify({ createdAt: "2026-05-10T12:00:00.000Z", id: "change-1", sequence: "2" }), "utf8").toString("base64url");

    service.changes("user-1", cursor);

    expect(prisma.syncChange.findMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        fileId: undefined,
        sequence: { gt: BigInt(2) }
      },
      orderBy: { sequence: "asc" },
      take: 500
    });
  });

  it("keeps accepting legacy timestamp cursors", () => {
    const { service, prisma } = createService(null);

    service.changes("user-1", "2026-05-10T12:00:00.000Z");

    expect(prisma.syncChange.findMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        fileId: undefined,
        OR: [{ createdAt: { gt: new Date("2026-05-10T12:00:00.000Z") } }]
      },
      orderBy: { sequence: "asc" },
      take: 500
    });
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
    expect(prisma.file.findFirst).toHaveBeenCalledWith({ where: { id: "file-1", userId: "user-1" }, select: { id: true } });
  });

  it("rejects changes for files outside the current user", async () => {
    const { service, prisma } = createService(null);
    prisma.file.findFirst.mockResolvedValue(null);

    await expect(service.submit("user-1", {
      fileId: "file-2",
      entityType: "file",
      entityId: "file-2",
      operation: "update",
      clientRequestId: "request-2"
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.syncChange.create).not.toHaveBeenCalled();
  });

  it("rejects oversized payloads", async () => {
    const { service, prisma } = createService(null);

    await expect(service.submit("user-1", {
      fileId: "file-1",
      entityType: "annotation",
      entityId: "annotation-1",
      operation: "update",
      clientRequestId: "request-3",
      payload: { value: "x".repeat(17 * 1024) }
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.syncChange.create).not.toHaveBeenCalled();
  });

  it("rejects direct create submissions", async () => {
    const { service, prisma } = createService(null);

    await expect(service.submit("user-1", {
      fileId: "file-1",
      entityType: "annotation",
      entityId: "annotation-1",
      operation: "create",
      clientRequestId: "request-4"
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.syncChange.create).not.toHaveBeenCalled();
  });

  it("rejects changes for annotations outside the current file", async () => {
    const { service, prisma } = createService(null);
    prisma.annotation.findFirst.mockResolvedValue(null);

    await expect(service.submit("user-1", {
      fileId: "file-1",
      entityType: "annotation",
      entityId: "annotation-2",
      operation: "update",
      clientRequestId: "request-5"
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.syncChange.create).not.toHaveBeenCalled();
  });
});
