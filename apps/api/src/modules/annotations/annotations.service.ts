import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";

type AnnotationType = "highlight" | "text_note";
const MAX_ANNOTATION_TEXT_LENGTH = 20000;
const MAX_ANNOTATION_NOTE_LENGTH = 10000;
const MAX_QUAD_POINTS = 100;
const MAX_COORDINATE_VALUE = 100000;

interface AnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
  coordinateSpace?: "pdf" | "viewport";
}

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
  baseVersion?: number;
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
    this.validateAnnotationInput(input);
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
    const current = await this.ensureAnnotation(userId, fileId, annotationId);
    this.validateAnnotationInput(input, true);
    if (input.baseVersion !== undefined && input.baseVersion !== current.version) {
      throw new ConflictException("Annotation has changed on another device");
    }
    const { baseVersion: _baseVersion, ...updateInput } = input;
    const annotation = await this.prisma.annotation.update({
      where: { id: annotationId },
      data: { ...updateInput, version: { increment: 1 } } as never
    });
    await this.recordChange(userId, fileId, "update", annotation.id, annotation.version, updateInput);
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

  private validateAnnotationInput(input: Partial<AnnotationInput>, partial = false) {
    if (!partial && input.type !== "highlight" && input.type !== "text_note") throw new BadRequestException("Annotation type is invalid");
    if (input.page !== undefined && (!Number.isInteger(input.page) || input.page < 1)) throw new BadRequestException("Annotation page is invalid");
    if (input.text !== undefined && input.text.length > MAX_ANNOTATION_TEXT_LENGTH) throw new BadRequestException("Annotation text is too long");
    if (input.note !== undefined && input.note.length > MAX_ANNOTATION_NOTE_LENGTH) throw new BadRequestException("Annotation note is too long");
    if (input.color !== undefined && !/^#[0-9A-Fa-f]{6}$/.test(input.color)) throw new BadRequestException("Annotation color is invalid");
    if (input.pageWidth !== undefined && input.pageWidth <= 0) throw new BadRequestException("Page width is invalid");
    if (input.pageHeight !== undefined && input.pageHeight <= 0) throw new BadRequestException("Page height is invalid");
    if (input.pageRotation !== undefined && !Number.isInteger(input.pageRotation)) throw new BadRequestException("Page rotation is invalid");
    if (input.deviceId !== undefined && input.deviceId.length > 200) throw new BadRequestException("Device id is too long");
    if (input.baseVersion !== undefined && (!Number.isInteger(input.baseVersion) || input.baseVersion < 1)) throw new BadRequestException("Annotation version is invalid");
    if (input.rect !== undefined && !this.isValidRect(input.rect)) throw new BadRequestException("Annotation rect is invalid");
    if (input.quadPoints !== undefined && !this.isValidQuadPoints(input.quadPoints)) throw new BadRequestException("Annotation quad points are invalid");
  }

  private isValidQuadPoints(value: unknown) {
    return Array.isArray(value) && value.length <= MAX_QUAD_POINTS && value.every((item) => this.isValidRect(item));
  }

  private isValidRect(value: unknown): value is AnnotationRect {
    if (!value || typeof value !== "object") return false;
    const rect = value as Partial<AnnotationRect>;
    const coordinates = [rect.x, rect.y, rect.width, rect.height];
    if (!coordinates.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate) && Math.abs(coordinate) <= MAX_COORDINATE_VALUE)) return false;
    if (rect.width === undefined || rect.height === undefined || rect.width <= 0 || rect.height <= 0) return false;
    return rect.coordinateSpace === undefined || rect.coordinateSpace === "pdf" || rect.coordinateSpace === "viewport";
  }
}
