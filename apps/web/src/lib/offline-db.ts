import Dexie, { type Table } from "dexie";

export interface PendingChange {
  id?: number;
  entityType: "file" | "annotation" | "reading_progress";
  entityId: string;
  operation: "create" | "update" | "delete";
  payload: unknown;
  createdAt: string;
}

export interface CachedPdfFile {
  fileId: string;
  data: ArrayBuffer;
  updatedAt: string;
}

class PageBridgeDb extends Dexie {
  pendingChanges!: Table<PendingChange, number>;
  pdfFiles!: Table<CachedPdfFile, string>;

  constructor() {
    super("pagebridge");
    this.version(1).stores({
      pendingChanges: "++id, entityType, entityId, createdAt"
    });
    this.version(2).stores({
      pendingChanges: "++id, entityType, entityId, createdAt",
      pdfFiles: "fileId, updatedAt"
    });
  }
}

export const offlineDb = new PageBridgeDb();
