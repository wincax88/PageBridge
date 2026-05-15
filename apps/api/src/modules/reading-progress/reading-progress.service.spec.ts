import { describe, expect, it, vi } from "vitest";
import { ReadingProgressService } from "./reading-progress.service";

function createService() {
  const currentProgress = {
    id: "progress-1",
    fileId: "file-1",
    userId: "user-1",
    deviceId: "web",
    page: 3,
    scrollOffset: 120,
    zoomMode: "custom",
    zoomValue: 1.25,
    updatedAt: new Date()
  };
  const prisma = {
    file: { findFirst: vi.fn().mockResolvedValue({ id: "file-1", userId: "user-1" }) },
    readingProgress: {
      findUnique: vi.fn().mockResolvedValue(currentProgress),
      upsert: vi.fn().mockResolvedValue(currentProgress)
    },
    syncChange: { create: vi.fn().mockResolvedValue({}) }
  };

  return { service: new ReadingProgressService(prisma as never), prisma };
}

describe("ReadingProgressService.save", () => {
  it("does not record a sync change when progress is unchanged", async () => {
    const { service, prisma } = createService();

    await expect(service.save("user-1", "file-1", {
      deviceId: "web",
      page: 3,
      scrollOffset: 120,
      zoomMode: "custom",
      zoomValue: 1.25
    })).resolves.toMatchObject({ id: "progress-1" });

    expect(prisma.readingProgress.upsert).not.toHaveBeenCalled();
    expect(prisma.syncChange.create).not.toHaveBeenCalled();
  });

  it("records a sync change when progress changes", async () => {
    const { service, prisma } = createService();

    await service.save("user-1", "file-1", {
      deviceId: "web",
      page: 4,
      scrollOffset: 120,
      zoomMode: "custom",
      zoomValue: 1.25
    });

    expect(prisma.readingProgress.upsert).toHaveBeenCalled();
    expect(prisma.syncChange.create).toHaveBeenCalled();
  });
});
