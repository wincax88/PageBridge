import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AnnotationsService } from "./annotations.service";

type AnnotationType = "highlight" | "text_note";

class UpsertAnnotationDto {
  type!: AnnotationType;
  page!: number;
  color?: string;
  text?: string;
  note?: string;
  quadPoints?: unknown;
  rect?: unknown;
  pageWidth?: number;
  pageHeight?: number;
  pageRotation?: number;
  deviceId?: string;
}

@UseGuards(JwtAuthGuard)
@Controller("files/:fileId/annotations")
export class AnnotationsController {
  constructor(private readonly annotations: AnnotationsService) {}

  @Get()
  list(@CurrentUser() user: CurrentUser, @Param("fileId") fileId: string) {
    return this.annotations.list(user.id, fileId);
  }

  @Post()
  create(@CurrentUser() user: CurrentUser, @Param("fileId") fileId: string, @Body() body: UpsertAnnotationDto) {
    return this.annotations.create(user.id, fileId, body);
  }

  @Patch(":annotationId")
  update(
    @CurrentUser() user: CurrentUser,
    @Param("fileId") fileId: string,
    @Param("annotationId") annotationId: string,
    @Body() body: Partial<UpsertAnnotationDto>
  ) {
    return this.annotations.update(user.id, fileId, annotationId, body);
  }

  @Delete(":annotationId")
  remove(@CurrentUser() user: CurrentUser, @Param("fileId") fileId: string, @Param("annotationId") annotationId: string) {
    return this.annotations.softDelete(user.id, fileId, annotationId);
  }
}
