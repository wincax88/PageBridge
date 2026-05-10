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

export function saveReadingProgress(token: string, fileId: string, page: number) {
  return apiRequest<ReadingProgressRecord>(
    `/files/${fileId}/progress`,
    {
      method: "PUT",
      body: JSON.stringify({ deviceId: "web", page, scrollOffset: 0, zoomMode: "fit_width" })
    },
    token
  );
}
