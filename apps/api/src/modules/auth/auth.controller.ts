import { Body, Controller, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { AuthService } from "./auth.service";

class AuthDto {
  email!: string;
  password!: string;
}

class RefreshTokenDto {
  refreshToken?: string;
}

const refreshCookieName = "pagebridge_refresh";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("register")
  async register(@Body() body: AuthDto, @Res({ passthrough: true }) response: Response) {
    const session = await this.auth.register(body.email, body.password);
    this.setRefreshCookie(response, session.refreshToken);
    return session;
  }

  @Post("login")
  async login(@Body() body: AuthDto, @Res({ passthrough: true }) response: Response) {
    const session = await this.auth.login(body.email, body.password);
    this.setRefreshCookie(response, session.refreshToken);
    return session;
  }

  @Post("refresh")
  async refresh(@Body() body: RefreshTokenDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const session = await this.auth.refresh(body.refreshToken ?? this.getRefreshCookie(request));
    this.setRefreshCookie(response, session.refreshToken);
    return session;
  }

  @Post("logout")
  logout(@Body() body: RefreshTokenDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.clearCookie(refreshCookieName, this.cookieOptions());
    return this.auth.logout(body.refreshToken ?? this.getRefreshCookie(request));
  }

  private setRefreshCookie(response: Response, refreshToken: string) {
    response.cookie(refreshCookieName, refreshToken, {
      ...this.cookieOptions(),
      maxAge: 30 * 24 * 60 * 60 * 1000
    });
  }

  private cookieOptions() {
    return {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax" as const,
      path: "/api/auth"
    };
  }

  private getRefreshCookie(request: Request) {
    const cookieHeader = request.headers.cookie;
    if (!cookieHeader) return undefined;

    return cookieHeader
      .split(";")
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith(`${refreshCookieName}=`))
      ?.slice(refreshCookieName.length + 1);
  }
}
