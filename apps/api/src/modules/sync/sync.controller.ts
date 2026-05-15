import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { SyncService } from "./sync.service";

@UseGuards(JwtAuthGuard)
@Controller("sync")
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Get("changes")
  changes(@CurrentUser() user: CurrentUser, @Query("since") since?: string, @Query("fileId") fileId?: string) {
    return this.sync.changes(user.id, since, fileId);
  }

  @Get("state")
  state(@CurrentUser() user: CurrentUser) {
    return this.sync.state(user.id);
  }
}
