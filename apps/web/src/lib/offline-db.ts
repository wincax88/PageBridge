import Dexie, { type Table } from "dexie";

export interface PendingChange {
  id?: number;
  userKey: string;
  entityType: "file" | "annotation" | "reading_progress";
  entityId: string;
  operation: "create" | "update" | "delete";
  payload: unknown;
  createdAt: string;
}

export interface CachedPdfFile {
  userKey: string;
  fileId: string;
  data: ArrayBuffer;
  updatedAt: string;
}

export interface CachedAnnotationList {
  userKey: string;
  fileId: string;
  annotations: unknown[];
  updatedAt: string;
}

class PageBridgeDb extends Dexie {
  pendingChanges!: Table<PendingChange, number>;
  pdfFiles!: Table<CachedPdfFile, [string, string]>;
  annotationLists!: Table<CachedAnnotationList, [string, string]>;

  constructor() {
    super("pagebridge");
    this.version(1).stores({
      pendingChanges: "++id, entityType, entityId, createdAt"
    });
    this.version(2).stores({
      pendingChanges: "++id, entityType, entityId, createdAt",
      pdfFiles: "fileId, updatedAt"
    });
    this.version(3).stores({
      pendingChanges: "++id, entityType, entityId, createdAt",
      pdfFiles: "fileId, updatedAt",
      annotationLists: "fileId, updatedAt"
    });
    this.version(4).stores({
      pendingChanges: "++id, userKey, [userKey+entityType], [userKey+entityId], createdAt",
      pdfFiles: "fileId, userKey, [userKey+fileId], updatedAt",
      annotationLists: "fileId, userKey, [userKey+fileId], updatedAt"
    }).upgrade(async (transaction) => {
      const legacyUserKey = typeof localStorage === "undefined" ? "legacy" : localStorage.getItem("pagebridge.userEmail") ?? "legacy";
      await transaction.table("pendingChanges").toCollection().modify((change) => {
        if (!change.userKey) change.userKey = legacyUserKey;
      });
      await transaction.table("pdfFiles").toCollection().modify((file) => {
        if (!file.userKey) file.userKey = legacyUserKey;
      });
      await transaction.table("annotationLists").toCollection().modify((list) => {
        if (!list.userKey) list.userKey = legacyUserKey;
      });
    });
  }
}

export const offlineDb = new PageBridgeDb();
