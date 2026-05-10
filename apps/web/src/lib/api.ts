const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "/api";

export interface AuthResponse {
  user: { id: string; email: string };
  accessToken: string;
  refreshToken: string;
}

export interface FileRecord {
  id: string;
  name: string;
  sizeBytes: string | number;
  pageCount: number | null;
  updatedAt: string;
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
  rect: { x: number; y: number; width: number; height: number } | null;
  pageWidth: number | null;
  pageHeight: number | null;
  version: number;
  updatedAt: string;
}

export async function apiRequest<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers
    }
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
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

export function listFiles(token: string) {
  return apiRequest<FileRecord[]>("/files", {}, token);
}

export function createFile(token: string, name: string) {
  return apiRequest<FileRecord>(
    "/files",
    {
      method: "POST",
      body: JSON.stringify({ name, sizeBytes: 0, pageCount: null })
    },
    token
  );
}

export async function uploadPdf(token: string, file: File) {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(`${apiBaseUrl}/files/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Upload failed: ${response.status}`);
  }

  return response.json() as Promise<FileRecord>;
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

export function deleteFile(token: string, fileId: string) {
  return apiRequest<FileRecord>(
    `/files/${fileId}`,
    {
      method: "DELETE"
    },
    token
  );
}

export async function downloadPdf(token: string, fileId: string) {
  const response = await fetch(`${apiBaseUrl}/files/${fileId}/content`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Download failed: ${response.status}`);
  }

  return response.arrayBuffer();
}

export function getReadingProgress(token: string, fileId: string) {
  return apiRequest<ReadingProgressRecord | null>(`/files/${fileId}/progress?deviceId=web`, {}, token);
}

export function saveReadingProgress(token: string, fileId: string, page: number, zoomValue: number) {
  return apiRequest<ReadingProgressRecord>(
    `/files/${fileId}/progress`,
    {
      method: "PUT",
      body: JSON.stringify({ deviceId: "web", page, scrollOffset: 0, zoomMode: "custom", zoomValue })
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
    rect: { x: number; y: number; width: number; height: number };
    pageWidth: number;
    pageHeight: number;
  }
) {
  return apiRequest<AnnotationRecord>(
    `/files/${fileId}/annotations`,
    {
      method: "POST",
      body: JSON.stringify({
        type: "text_note",
        page: input.page,
        color: "#C96E3A",
        note: input.note,
        rect: input.rect,
        pageWidth: input.pageWidth,
        pageHeight: input.pageHeight,
        pageRotation: 0,
        deviceId: "web"
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

export function updateAnnotationNote(token: string, fileId: string, annotationId: string, note: string) {
  return apiRequest<AnnotationRecord>(
    `/files/${fileId}/annotations/${annotationId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ note })
    },
    token
  );
}
