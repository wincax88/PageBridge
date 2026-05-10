import { Body, Controller, Get, Param, Put, Query, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ReadingProgressService } from "./reading-progress.service";

class SaveProgressDto {
  deviceId?: string;
  page!: number;
  scrollOffset?: number;
  zoomMode?: string;
  zoomValue?: number;
}

@UseGuards(JwtAuthGuard)
@Controller("files/:fileId/progress")
export class ReadingProgressController {
  constructor(private readonly progress: ReadingProgressService) {}

  @Get()
  get(@CurrentUser() user: CurrentUser, @Param("fileId") fileId: string, @Query("deviceId") deviceId?: string) {
    return this.progress.get(user.id, fileId, deviceId);
  }

  @Put()
  save(@CurrentUser() user: CurrentUser, @Param("fileId") fileId: string, @Body() body: SaveProgressDto) {
    return this.progress.save(user.id, fileId, body);
  }
}
