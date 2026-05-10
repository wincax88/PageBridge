import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { Allow, IsIn, IsInt, IsOptional, IsString } from "class-validator";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { SyncService } from "./sync.service";

type ChangeEntityType = "file" | "annotation" | "reading_progress";
type ChangeOperation = "create" | "update" | "delete";

class SubmitChangeDto {
  @IsOptional()
  @IsString()
  fileId?: string;

  @IsIn(["file", "annotation", "reading_progress"])
  entityType!: ChangeEntityType;

  @IsString()
  entityId!: string;

  @IsIn(["create", "update", "delete"])
  operation!: ChangeOperation;

  @IsOptional()
  @IsInt()
  baseVersion?: number;

  @IsOptional()
  @IsInt()
  nextVersion?: number;

  @IsString()
  clientRequestId!: string;

  @IsOptional()
  @Allow()
  payload?: unknown;
}

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

  @Post("changes")
  submit(@CurrentUser() user: CurrentUser, @Body() body: SubmitChangeDto) {
    return this.sync.submit(user.id, body);
  }
}
