import { Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";

type AnnotationType = "highlight" | "text_note";

interface AnnotationInput {
  type: AnnotationType;
  page: number;
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

@Injectable()
export class AnnotationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, fileId: string) {
    await this.ensureFile(userId, fileId);
    return this.prisma.annotation.findMany({
      where: { userId, fileId, deletedAt: null },
      orderBy: [{ page: "asc" }, { updatedAt: "desc" }]
    });
  }

  async create(userId: string, fileId: string, input: AnnotationInput) {
    await this.ensureFile(userId, fileId);
    const annotation = await this.prisma.annotation.create({
      data: {
        userId,
        fileId,
        type: input.type,
        page: input.page,
        color: input.color,
        text: input.text,
        note: input.note,
        quadPoints: input.quadPoints as never,
        rect: input.rect as never,
        pageWidth: input.pageWidth,
        pageHeight: input.pageHeight,
        pageRotation: input.pageRotation,
        deviceId: input.deviceId
      }
    });
    await this.recordChange(userId, fileId, "create", annotation.id, annotation.version, annotation);
    return annotation;
  }

  async update(userId: string, fileId: string, annotationId: string, input: Partial<AnnotationInput>) {
    await this.ensureAnnotation(userId, fileId, annotationId);
    const annotation = await this.prisma.annotation.update({
      where: { id: annotationId },
      data: { ...input, version: { increment: 1 } } as never
    });
    await this.recordChange(userId, fileId, "update", annotation.id, annotation.version, input);
    return annotation;
  }

  async softDelete(userId: string, fileId: string, annotationId: string) {
    await this.ensureAnnotation(userId, fileId, annotationId);
    const annotation = await this.prisma.annotation.update({
      where: { id: annotationId },
      data: { deletedAt: new Date(), version: { increment: 1 } }
    });
    await this.recordChange(userId, fileId, "delete", annotation.id, annotation.version, { deletedAt: annotation.deletedAt?.toISOString() });
    return annotation;
  }

  private async recordChange(
    userId: string,
    fileId: string,
    operation: "create" | "update" | "delete",
    entityId: string,
    nextVersion: number,
    payload: unknown
  ) {
    await this.prisma.syncChange.create({
      data: {
        userId,
        fileId,
        entityType: "annotation",
        entityId,
        operation,
        nextVersion,
        clientRequestId: randomUUID(),
        payload: payload as never
      }
    });
  }

  private async ensureAnnotation(userId: string, fileId: string, annotationId: string) {
    const annotation = await this.prisma.annotation.findFirst({ where: { id: annotationId, userId, fileId, deletedAt: null } });
    if (!annotation) throw new NotFoundException("Annotation not found");
    return annotation;
  }

  private async ensureFile(userId: string, fileId: string) {
    const file = await this.prisma.file.findFirst({ where: { id: fileId, userId, deletedAt: null } });
    if (!file) throw new NotFoundException("File not found");
    return file;
  }
}
