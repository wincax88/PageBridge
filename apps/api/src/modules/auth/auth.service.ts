import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { compare, hash } from "bcryptjs";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";

interface RefreshPayload {
  sub: string;
  email: string;
  jti: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly redis: RedisService
  ) {}

  async register(email: string, password: string) {
    const normalizedEmail = this.normalizeEmail(email);
    this.validatePassword(password);
    await this.redis.limit(`rate:auth:register:${normalizedEmail}`, 5, 60 * 60);
    const existing = await this.prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) throw new ConflictException("Email is already registered");

    const user = await this.prisma.user.create({
      data: { email: normalizedEmail, passwordHash: await hash(password, 12) }
    });

    return this.issueTokens(user.id, user.email);
  }

  async login(email: string, password: string) {
    const normalizedEmail = this.normalizeEmail(email);
    if (!password) throw new UnauthorizedException("Invalid email or password");
    await this.redis.limit(`rate:auth:login:${normalizedEmail}`, 10, 15 * 60);

    const user = await this.prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!user || !(await compare(password, user.passwordHash))) {
      throw new UnauthorizedException("Invalid email or password");
    }

    return this.issueTokens(user.id, user.email);
  }

  async refresh(refreshToken?: string) {
    if (!refreshToken) throw new UnauthorizedException("Invalid refresh token");
    try {
      const payload = await this.jwt.verifyAsync<RefreshPayload>(refreshToken, {
        secret: this.config.get<string>("JWT_REFRESH_SECRET") ?? "dev-refresh-secret"
      });

      const stored = await this.prisma.refreshToken.findUnique({ where: { id: payload.jti }, include: { user: true } });
      if (!stored || stored.revokedAt || stored.expiresAt <= new Date()) throw new UnauthorizedException("Invalid refresh token");
      if (!(await compare(refreshToken, stored.tokenHash))) throw new UnauthorizedException("Invalid refresh token");

      await this.prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
      return this.issueTokens(stored.user.id, stored.user.email);
    } catch {
      throw new UnauthorizedException("Invalid refresh token");
    }
  }

  async logout(refreshToken?: string) {
    if (!refreshToken) return { ok: true };
    try {
      const payload = await this.jwt.verifyAsync<RefreshPayload>(refreshToken, {
        secret: this.config.get<string>("JWT_REFRESH_SECRET") ?? "dev-refresh-secret"
      });
      await this.prisma.refreshToken.updateMany({ where: { id: payload.jti }, data: { revokedAt: new Date() } });
    } catch {
      // Logout should be idempotent from the client perspective.
    }

    return { ok: true };
  }

  private async issueTokens(userId: string, email: string) {
    const refreshTokenId = randomUUID();
    const payload = { sub: userId, email };
    const refreshToken = this.jwt.sign(
      { ...payload, jti: refreshTokenId },
      {
        secret: this.config.get<string>("JWT_REFRESH_SECRET") ?? "dev-refresh-secret",
        expiresIn: "30d"
      }
    );

    await this.prisma.refreshToken.create({
      data: {
        id: refreshTokenId,
        userId,
        tokenHash: await hash(refreshToken, 12),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      }
    });

    return {
      user: { id: userId, email },
      accessToken: this.jwt.sign(payload, {
        secret: this.config.get<string>("JWT_ACCESS_SECRET") ?? "dev-access-secret",
        expiresIn: "15m"
      }),
      refreshToken
    };
  }

  private normalizeEmail(email: string) {
    const normalizedEmail = email?.trim().toLowerCase();
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new BadRequestException("A valid email is required");
    }
    return normalizedEmail;
  }

  private validatePassword(password: string) {
    if (!password || password.length < 8) {
      throw new BadRequestException("Password must be at least 8 characters");
    }
  }
}
