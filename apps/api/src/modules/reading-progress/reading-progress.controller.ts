import { Body, Controller, Get, Param, Put, Query, UseGuards } from "@nestjs/common";
import { IsInt, IsNumber, IsOptional, IsString } from "class-validator";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ReadingProgressService } from "./reading-progress.service";

class SaveProgressDto {
  @IsOptional()
  @IsString()
  deviceId?: string;

  @IsInt()
  page!: number;

  @IsOptional()
  @IsNumber()
  scrollOffset?: number;

  @IsOptional()
  @IsString()
  zoomMode?: string;

  @IsOptional()
  @IsNumber()
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
