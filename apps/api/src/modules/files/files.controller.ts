import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { FilesService } from "./files.service";

class CreateFileDto {
  name!: string;
  sizeBytes!: number;
  storageKey?: string;
  pageCount?: number;
}

class RenameFileDto {
  name!: string;
}

@UseGuards(JwtAuthGuard)
@Controller("files")
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Get()
  list(@CurrentUser() user: CurrentUser) {
    return this.files.list(user.id);
  }

  @Post()
  create(@CurrentUser() user: CurrentUser, @Body() body: CreateFileDto) {
    return this.files.create(user.id, body);
  }

  @Patch(":fileId")
  rename(@CurrentUser() user: CurrentUser, @Param("fileId") fileId: string, @Body() body: RenameFileDto) {
    return this.files.rename(user.id, fileId, body.name);
  }

  @Delete(":fileId")
  remove(@CurrentUser() user: CurrentUser, @Param("fileId") fileId: string) {
    return this.files.softDelete(user.id, fileId);
  }
}
