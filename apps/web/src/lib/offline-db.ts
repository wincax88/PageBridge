import Dexie, { type Table } from "dexie";

export interface PendingChange {
  id?: number;
  entityType: "file" | "annotation" | "reading_progress";
  entityId: string;
  operation: "create" | "update" | "delete";
  payload: unknown;
  createdAt: string;
}

class PageBridgeDb extends Dexie {
  pendingChanges!: Table<PendingChange, number>;

  constructor() {
    super("pagebridge");
    this.version(1).stores({
      pendingChanges: "++id, entityType, entityId, createdAt"
    });
  }
}

export const offlineDb = new PageBridgeDb();
