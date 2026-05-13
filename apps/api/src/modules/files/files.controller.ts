import { Body, Controller, Delete, Get, Header, Param, Patch, Post, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { IsInt, IsNumber, IsString } from "class-validator";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { FilesService } from "./files.service";

class RenameFileDto {
  @IsString()
  name!: string;
}

class UpdatePageCountDto {
  @IsInt()
  pageCount!: number;
}

class CreateUploadTargetDto {
  @IsString()
  name!: string;

  @IsNumber()
  sizeBytes!: number;
}

class CompleteUploadDto {
  @IsString()
  fileId!: string;

  @IsString()
  name!: string;

  @IsNumber()
  sizeBytes!: number;

  @IsString()
  storageKey!: string;
}

@UseGuards(JwtAuthGuard)
@Controller("files")
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Get()
  list(@CurrentUser() user: CurrentUser) {
    return this.files.list(user.id);
  }

  @Get("usage")
  usage(@CurrentUser() user: CurrentUser) {
    return this.files.usage(user.id);
  }

  @Get("trash")
  trash(@CurrentUser() user: CurrentUser) {
    return this.files.listDeleted(user.id);
  }

  @Post("upload")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 200 * 1024 * 1024 } }))
  upload(@CurrentUser() user: CurrentUser, @UploadedFile() file: Express.Multer.File) {
    return this.files.upload(user.id, file);
  }

  @Post("upload-target")
  createUploadTarget(@CurrentUser() user: CurrentUser, @Body() body: CreateUploadTargetDto) {
    return this.files.createUploadTarget(user.id, body.name, body.sizeBytes);
  }

  @Post("complete-upload")
  completeUpload(@CurrentUser() user: CurrentUser, @Body() body: CompleteUploadDto) {
    return this.files.completeUpload(user.id, body);
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

  @Patch(":fileId/page-count")
  updatePageCount(@CurrentUser() user: CurrentUser, @Param("fileId") fileId: string, @Body() body: UpdatePageCountDto) {
    return this.files.updatePageCount(user.id, fileId, body.pageCount);
  }

  @Patch("trash/:fileId/restore")
  restore(@CurrentUser() user: CurrentUser, @Param("fileId") fileId: string) {
    return this.files.restore(user.id, fileId);
  }

  @Delete("trash")
  emptyTrash(@CurrentUser() user: CurrentUser) {
    return this.files.emptyTrash(user.id);
  }

  @Delete("trash/:fileId")
  permanentlyDelete(@CurrentUser() user: CurrentUser, @Param("fileId") fileId: string) {
    return this.files.permanentlyDelete(user.id, fileId);
  }

  @Delete(":fileId")
  remove(@CurrentUser() user: CurrentUser, @Param("fileId") fileId: string) {
    return this.files.softDelete(user.id, fileId);
  }
}
