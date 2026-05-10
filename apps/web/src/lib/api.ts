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
