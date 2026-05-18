import { useAuthStore } from "../store/auth-store";

declare global {
  interface Window {
    __PAGEBRIDGE_CONFIG__?: {
      VITE_API_BASE_URL?: string;
    };
  }
}

const apiBaseUrl = window.__PAGEBRIDGE_CONFIG__?.VITE_API_BASE_URL ?? import.meta.env.VITE_API_BASE_URL ?? "/api";
let refreshPromise: Promise<AuthResponse | null> | null = null;

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export interface AuthResponse {
  user: { id: string; email: string };
  accessToken: string;
}

export interface FileRecord {
  id: string;
  name: string;
  sizeBytes: string | number;
  pageCount: number | null;
  isFavorite: boolean;
  updatedAt: string;
}

export interface DeletedFileRecord extends FileRecord {
  deletedAt: string;
}

export interface StorageUsageRecord {
  usedBytes: string;
  quotaBytes: string;
  fileCount: number;
  fileCountQuota: number;
}

export interface ReadingProgressRecord {
  id: string;
  fileId: string;
  page: number;
  scrollOffset: number;
  zoomMode: string;
  zoomValue: number | null;
  updatedAt: string;
}

export interface AnnotationRecord {
  id: string;
  fileId: string;
  type: "highlight" | "text_note";
  page: number;
  color: string;
  text: string | null;
  note: string | null;
  quadPoints: { x: number; y: number; width: number; height: number; coordinateSpace?: "pdf" | "viewport" }[] | null;
  rect: { x: number; y: number; width: number; height: number; coordinateSpace?: "pdf" | "viewport" } | null;
  pageWidth: number | null;
  pageHeight: number | null;
  version: number;
  updatedAt: string;
}

interface UploadTargetRecord {
  fileId: string;
  name: string;
  storageKey: string;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
}

export interface SyncChangeRecord {
  id: string;
  sequence: string;
  fileId: string | null;
  entityType: "file" | "annotation" | "reading_progress";
  entityId: string;
  operation: "create" | "update" | "delete";
  createdAt: string;
}

export interface SyncStateRecord {
  latestChangeId: string | null;
  cursor: string;
}

export async function apiRequest<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetchWithAuthRetry(path, options, token, true);

  if (!response.ok) {
    const message = await response.text();
    throw new ApiError(message || `Request failed: ${response.status}`, response.status);
  }

  return response.json() as Promise<T>;
}

async function fetchWithAuthRetry(path: string, options: RequestInit = {}, token?: string, isJson = false) {
  const response = await fetchApi(path, options, token, isJson);
  if (response.status !== 401 || !token) return response;

  const refreshed = await refreshAccessToken();
  if (!refreshed) return response;

  return fetchApi(path, options, refreshed.accessToken, isJson);
}

function fetchApi(path: string, options: RequestInit = {}, token?: string, isJson = false) {
  const shouldSetJsonContentType = isJson && !(options.body instanceof FormData);

  return fetch(`${apiBaseUrl}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      ...(shouldSetJsonContentType ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers
    }
  });
}

export async function refreshAccessToken() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = performRefreshAccessToken().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

async function performRefreshAccessToken() {
  const response = await fetchApi("/auth/refresh", {
    method: "POST",
    body: JSON.stringify({})
  }, undefined, true);

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      useAuthStore.getState().clearSession();
      return null;
    }
    throw new ApiError(`Refresh failed: ${response.status}`, response.status);
  }

  const session = (await response.json()) as AuthResponse;
  useAuthStore.getState().setSession(session.accessToken, session.user.email);
  return session;
}

export function login(email: string, password: string) {
  return apiRequest<AuthResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
}

export function register(email: string, password: string) {
  return apiRequest<AuthResponse>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
}

export function logout() {
  return apiRequest<{ ok: boolean }>("/auth/logout", {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function listFiles(token: string) {
  return apiRequest<FileRecord[]>("/files", {}, token);
}

export function getStorageUsage(token: string) {
  return apiRequest<StorageUsageRecord>("/files/usage", {}, token);
}

export function listDeletedFiles(token: string) {
  return apiRequest<DeletedFileRecord[]>("/files/trash", {}, token);
}

export function listSyncChanges(token: string, since: string) {
  return apiRequest<SyncChangeRecord[]>(`/sync/changes?since=${encodeURIComponent(since)}`, {}, token);
}

export function getSyncState(token: string) {
  return apiRequest<SyncStateRecord>("/sync/state", {}, token);
}

export async function uploadPdf(token: string, file: File) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("name", file.name);

  return apiRequest<FileRecord>("/files/upload", { method: "POST", body: formData }, token);
}

export function renameFile(token: string, fileId: string, name: string) {
  return apiRequest<FileRecord>(
    `/files/${fileId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ name })
    },
    token
  );
}

export function updateFilePageCount(token: string, fileId: string, pageCount: number) {
  return apiRequest<FileRecord>(
    `/files/${fileId}/page-count`,
    {
      method: "PATCH",
      body: JSON.stringify({ pageCount })
    },
    token
  );
}

export function updateFileFavorite(token: string, fileId: string, isFavorite: boolean) {
  return apiRequest<FileRecord>(
    `/files/${fileId}/favorite`,
    {
      method: "PATCH",
      body: JSON.stringify({ isFavorite })
    },
    token
  );
}

export function deleteFile(token: string, fileId: string) {
  return apiRequest<FileRecord>(
    `/files/${fileId}`,
    {
      method: "DELETE"
    },
    token
  );
}

export function restoreFile(token: string, fileId: string) {
  return apiRequest<FileRecord>(
    `/files/trash/${fileId}/restore`,
    {
      method: "PATCH"
    },
    token
  );
}

export function permanentlyDeleteFile(token: string, fileId: string) {
  return apiRequest<{ ok: boolean }>(
    `/files/trash/${fileId}`,
    {
      method: "DELETE"
    },
    token
  );
}

export function emptyTrash(token: string) {
  return apiRequest<{ ok: boolean; deletedCount: number }>(
    "/files/trash",
    {
      method: "DELETE"
    },
    token
  );
}

export async function downloadPdf(token: string, fileId: string) {
  const response = await fetchWithAuthRetry(`/files/${fileId}/content`, {}, token);

  if (!response.ok) {
    const message = await response.text();
    throw new ApiError(message || `Download failed: ${response.status}`, response.status);
  }

  return response.arrayBuffer();
}

export function getReadingProgress(token: string, fileId: string) {
  return apiRequest<ReadingProgressRecord | null>(`/files/${fileId}/progress?deviceId=web`, {}, token);
}

export function saveReadingProgress(token: string, fileId: string, page: number, zoomValue: number, zoomMode = "custom", scrollOffset = 0) {
  return apiRequest<ReadingProgressRecord>(
    `/files/${fileId}/progress`,
    {
      method: "PUT",
      body: JSON.stringify({ deviceId: "web", page, scrollOffset, zoomMode, zoomValue })
    },
    token
  );
}

export function listAnnotations(token: string, fileId: string) {
  return apiRequest<AnnotationRecord[]>(`/files/${fileId}/annotations`, {}, token);
}

export function createTextNoteAnnotation(
  token: string,
  fileId: string,
  input: {
    page: number;
    note: string;
    rect: { x: number; y: number; width: number; height: number; coordinateSpace?: "pdf" | "viewport" };
    pageWidth: number;
    pageHeight: number;
    color?: string;
    clientRequestId?: string;
  }
) {
  return apiRequest<AnnotationRecord>(
    `/files/${fileId}/annotations`,
    {
      method: "POST",
      body: JSON.stringify({
        type: "text_note",
        page: input.page,
        color: input.color ?? "#C96E3A",
        note: input.note,
        rect: input.rect,
        pageWidth: input.pageWidth,
        pageHeight: input.pageHeight,
        pageRotation: 0,
        deviceId: "web",
        clientRequestId: input.clientRequestId
      })
    },
    token
  );
}

export function createHighlightAnnotation(
  token: string,
  fileId: string,
  input: {
    page: number;
    text: string;
    quadPoints: { x: number; y: number; width: number; height: number; coordinateSpace?: "pdf" | "viewport" }[];
    pageWidth: number;
    pageHeight: number;
    color?: string;
    note?: string | null;
    clientRequestId?: string;
  }
) {
  return apiRequest<AnnotationRecord>(
    `/files/${fileId}/annotations`,
    {
      method: "POST",
      body: JSON.stringify({
        type: "highlight",
        page: input.page,
        color: input.color ?? "#FFE066",
        text: input.text,
        note: input.note ?? undefined,
        quadPoints: input.quadPoints,
        pageWidth: input.pageWidth,
        pageHeight: input.pageHeight,
        pageRotation: 0,
        deviceId: "web",
        clientRequestId: input.clientRequestId
      })
    },
    token
  );
}

export function deleteAnnotation(token: string, fileId: string, annotationId: string) {
  return apiRequest<AnnotationRecord>(
    `/files/${fileId}/annotations/${annotationId}`,
    {
      method: "DELETE"
    },
    token
  );
}

export function updateAnnotation(
  token: string,
  fileId: string,
  annotationId: string,
  input: { note?: string; color?: string; baseVersion?: number }
) {
  return apiRequest<AnnotationRecord>(
    `/files/${fileId}/annotations/${annotationId}`,
    {
      method: "PATCH",
      body: JSON.stringify(input)
    },
    token
  );
}
