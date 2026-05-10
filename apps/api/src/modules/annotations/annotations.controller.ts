import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { Allow, IsIn, IsInt, IsNumber, IsOptional, IsString } from "class-validator";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AnnotationsService } from "./annotations.service";

type AnnotationType = "highlight" | "text_note";

class UpsertAnnotationDto {
  @IsOptional()
  @IsIn(["highlight", "text_note"])
  type!: AnnotationType;

  @IsOptional()
  @IsInt()
  page!: number;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @IsString()
  text?: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @Allow()
  quadPoints?: unknown;

  @IsOptional()
  @Allow()
  rect?: unknown;

  @IsOptional()
  @IsNumber()
  pageWidth?: number;

  @IsOptional()
  @IsNumber()
  pageHeight?: number;

  @IsOptional()
  @IsInt()
  pageRotation?: number;

  @IsOptional()
  @IsString()
  deviceId?: string;

  @IsOptional()
  @IsInt()
  baseVersion?: number;
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
