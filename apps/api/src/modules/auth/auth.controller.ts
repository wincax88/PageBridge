import { Body, Controller, Post, Req, Res } from "@nestjs/common";
import { IsEmail, IsString, MinLength } from "class-validator";
import type { Request, Response } from "express";
import { AuthService } from "./auth.service";

class AuthDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

const refreshCookieName = "pagebridge_refresh";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("register")
  async register(@Body() body: AuthDto, @Res({ passthrough: true }) response: Response) {
    const session = await this.auth.register(body.email, body.password);
    this.setRefreshCookie(response, session.refreshToken);
    return this.publicSession(session);
  }

  @Post("login")
  async login(@Body() body: AuthDto, @Res({ passthrough: true }) response: Response) {
    const session = await this.auth.login(body.email, body.password);
    this.setRefreshCookie(response, session.refreshToken);
    return this.publicSession(session);
  }

  @Post("refresh")
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const session = await this.auth.refresh(this.getRefreshCookie(request));
    this.setRefreshCookie(response, session.refreshToken);
    return this.publicSession(session);
  }

  @Post("logout")
  logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.clearCookie(refreshCookieName, this.cookieOptions());
    return this.auth.logout(this.getRefreshCookie(request));
  }

  private setRefreshCookie(response: Response, refreshToken: string) {
    response.cookie(refreshCookieName, refreshToken, {
      ...this.cookieOptions(),
      maxAge: 30 * 24 * 60 * 60 * 1000
    });
  }

  private publicSession(session: { user: { id: string; email: string }; accessToken: string }) {
    return {
      user: session.user,
      accessToken: session.accessToken
    };
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
