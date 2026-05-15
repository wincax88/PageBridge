import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

interface SyncCursor {
  createdAt: Date;
  sequence?: bigint;
  id?: string;
}

@Injectable()
export class SyncService {
  constructor(private readonly prisma: PrismaService) {}

  changes(userId: string, since?: string, fileId?: string) {
    const cursor = since ? this.parseCursor(since) : undefined;

    return this.prisma.syncChange.findMany({
      where: {
        userId,
        fileId,
        ...(cursor
          ? cursor.sequence !== undefined
            ? { sequence: { gt: cursor.sequence } }
            : {
                OR: [
                  { createdAt: { gt: cursor.createdAt } },
                  ...(cursor.id ? [{ createdAt: cursor.createdAt, id: { gt: cursor.id } }] : [])
                ]
              }
          : {})
      },
      orderBy: { sequence: "asc" },
      take: 500
    }).then((changes) => changes.map((change) => this.serializeChange(change)));
  }

  async state(userId: string) {
    const latest = await this.prisma.syncChange.findFirst({
      where: { userId },
      orderBy: { sequence: "desc" },
      select: { id: true, createdAt: true, sequence: true }
    });

    return {
      latestChangeId: latest?.id ?? null,
      cursor: latest ? this.encodeCursor(latest.createdAt, latest.id, latest.sequence) : this.encodeCursor(new Date(0), "", BigInt(0))
    };
  }

  private encodeCursor(createdAt: Date, id: string, sequence: bigint) {
    return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id, sequence: sequence.toString() }), "utf8").toString("base64url");
  }

  private parseCursor(cursor: string): SyncCursor {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { createdAt?: unknown; id?: unknown };
      const rawParsed = parsed as { createdAt?: unknown; id?: unknown; sequence?: unknown };
      const createdAt = typeof parsed.createdAt === "string" ? new Date(parsed.createdAt) : null;
      if (!createdAt || Number.isNaN(createdAt.getTime()) || (parsed.id !== undefined && typeof parsed.id !== "string")) throw new Error("invalid cursor");
      if (rawParsed.sequence !== undefined && (typeof rawParsed.sequence !== "string" || !/^\d+$/.test(rawParsed.sequence))) throw new Error("invalid cursor");
      return { createdAt, id: parsed.id, sequence: rawParsed.sequence === undefined ? undefined : BigInt(rawParsed.sequence) };
    } catch {
      const createdAt = new Date(cursor);
      if (Number.isNaN(createdAt.getTime())) throw new BadRequestException("Sync cursor is invalid");
      return { createdAt };
    }
  }

  private serializeChange<T extends { sequence: bigint }>(change: T) {
    return { ...change, sequence: change.sequence.toString() };
  }
}
