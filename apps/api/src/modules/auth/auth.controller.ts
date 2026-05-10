import { Body, Controller, Post } from "@nestjs/common";
import { AuthService } from "./auth.service";

class AuthDto {
  email!: string;
  password!: string;
}

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("register")
  register(@Body() body: AuthDto) {
    return this.auth.register(body.email, body.password);
  }

  @Post("login")
  login(@Body() body: AuthDto) {
    return this.auth.login(body.email, body.password);
  }
}
