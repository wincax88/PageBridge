export type SyncStatus = "synced" | "syncing" | "pending" | "failed" | "conflict";

export type AnnotationType = "highlight" | "text_note";

export interface FileSummary {
  id: string;
  name: string;
  sizeBytes: number;
  pageCount: number | null;
  updatedAt: string;
}

export interface AnnotationDto {
  id: string;
  fileId: string;
  type: AnnotationType;
  page: number;
  color: string;
  text?: string | null;
  note?: string | null;
  version: number;
  updatedAt: string;
}
