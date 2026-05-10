import { Body, Controller, Delete, Get, Header, Param, Patch, Post, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
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

  @Post("upload")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 200 * 1024 * 1024 } }))
  upload(@CurrentUser() user: CurrentUser, @UploadedFile() file: Express.Multer.File) {
    return this.files.upload(user.id, file);
  }

  @Get(":fileId/content")
  @Header("Content-Type", "application/pdf")
  async content(@CurrentUser() user: CurrentUser, @Param("fileId") fileId: string) {
    const file = await this.files.getContent(user.id, fileId);
    return new StreamableFile(file.buffer, {
      disposition: `inline; filename="${encodeURIComponent(file.name)}"`,
      type: "application/pdf"
    });
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
