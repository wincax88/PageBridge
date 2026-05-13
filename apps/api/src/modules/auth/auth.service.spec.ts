import { UnauthorizedException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "./auth.service";

vi.mock("bcryptjs", () => ({
  compare: vi.fn().mockResolvedValue(true),
  hash: vi.fn().mockResolvedValue("hashed-token")
}));

function createService() {
  const storedToken = {
    id: "refresh-1",
    tokenHash: "hashed-refresh",
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    user: { id: "user-1", email: "reader@example.com" }
  };
  const prisma = {
    refreshToken: {
      findUnique: vi.fn().mockResolvedValue(storedToken),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue({})
    },
    user: {
      findUnique: vi.fn(),
      create: vi.fn()
    }
  };
  const jwt = {
    verifyAsync: vi.fn().mockResolvedValue({ sub: "user-1", email: "reader@example.com", jti: "refresh-1" }),
    sign: vi.fn().mockImplementation((payload) => (payload.jti ? "new-refresh-token" : "new-access-token"))
  };
  const config = { get: vi.fn().mockReturnValue("secret") };
  const redis = { limit: vi.fn().mockResolvedValue(undefined) };

  return {
    service: new AuthService(prisma as never, jwt as never, config as never, redis as never),
    prisma,
    jwt
  };
}

describe("AuthService refresh/logout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects refresh without a token", async () => {
    const { service } = createService();

    await expect(service.refresh()).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rotates a valid refresh token", async () => {
    const { service, prisma } = createService();

    const session = await service.refresh("old-refresh-token");

    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { id: "refresh-1", revokedAt: null, expiresAt: { gt: expect.any(Date) } },
      data: { revokedAt: expect.any(Date) }
    });
    expect(prisma.refreshToken.create).toHaveBeenCalled();
    expect(session).toEqual({
      user: { id: "user-1", email: "reader@example.com" },
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token"
    });
  });

  it("rejects refresh when another request already rotated the token", async () => {
    const { service, prisma } = createService();
    prisma.refreshToken.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.refresh("old-refresh-token")).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it("allows logout without a token", async () => {
    const { service, prisma } = createService();

    await expect(service.logout()).resolves.toEqual({ ok: true });
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it("revokes the matching refresh token on logout", async () => {
    const { service, prisma } = createService();

    await expect(service.logout("refresh-token")).resolves.toEqual({ ok: true });
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({ where: { id: "refresh-1" }, data: { revokedAt: expect.any(Date) } });
  });
});
