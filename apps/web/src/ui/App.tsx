import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteFile, getStorageUsage, getSyncState, listFiles, listSyncChanges, login, logout, register, renameFile, uploadPdf, type FileRecord } from "../lib/api";
import { offlineDb } from "../lib/offline-db";
import { useAuthStore } from "../store/auth-store";

const PdfReader = lazy(() => import("./PdfReader"));
const MAX_UPLOAD_SIZE_BYTES = 200 * 1024 * 1024;
const SYNC_POLL_INTERVAL_MS = 2000;

interface PendingFileRenamePayload {
  fileId: string;
  name: string;
}

interface PendingFileDeletePayload {
  fileId: string;
}

interface PendingFileUploadPayload {
  name: string;
  type: string;
  lastModified: number;
  data: ArrayBuffer;
}

export function App() {
  const queryClient = useQueryClient();
  const syncCursorRef = useRef(new Date().toISOString());
  const selectedFileRef = useRef<FileRecord | null>(null);
  const { accessToken, refreshToken, userEmail, setSession, clearSession } = useAuthStore();
  const [email, setEmail] = useState("demo@pagebridge.dev");
  const [password, setPassword] = useState("pagebridge123");
  const [selectedFile, setSelectedFile] = useState<FileRecord | null>(null);
  const [fileActionError, setFileActionError] = useState<string | null>(null);
  const [fileSyncStatus, setFileSyncStatus] = useState<"idle" | "queued" | "syncing" | "failed">("idle");
  const [fileSearch, setFileSearch] = useState("");
  const [syncPulse, setSyncPulse] = useState(0);
  const [renameTarget, setRenameTarget] = useState<FileRecord | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<FileRecord | null>(null);

  useEffect(() => {
    selectedFileRef.current = selectedFile;
  }, [selectedFile]);

  const filesQuery = useQuery({
    queryKey: ["files", accessToken],
    queryFn: () => listFiles(accessToken!),
    enabled: Boolean(accessToken)
  });

  const storageUsageQuery = useQuery({
    queryKey: ["storage-usage", accessToken],
    queryFn: () => getStorageUsage(accessToken!),
    enabled: Boolean(accessToken)
  });

  const authMutation = useMutation({
    mutationFn: async (mode: "login" | "register") => (mode === "login" ? login(email, password) : register(email, password)),
    onSuccess: (session) => setSession(session.accessToken, session.refreshToken, session.user.email)
  });

  const logoutMutation = useMutation({
    mutationFn: () => (refreshToken ? logout(refreshToken) : Promise.resolve({ ok: true })),
    onSettled: () => {
      setSelectedFile(null);
      queryClient.clear();
      clearSession();
    }
  });

  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadPdf(accessToken!, file),
    onSuccess: (file) => {
      setSelectedFile(file);
      setFileActionError(null);
      queryClient.invalidateQueries({ queryKey: ["files", accessToken] });
      queryClient.invalidateQueries({ queryKey: ["storage-usage", accessToken] });
    },
    onError: (error) => setFileActionError(error instanceof Error ? error.message : "Failed to upload PDF")
  });

  const renameFileMutation = useMutation({
    mutationFn: ({ fileId, name }: { fileId: string; name: string }) => renameFile(accessToken!, fileId, name),
    onSuccess: (file) => {
      setSelectedFile((current) => (current?.id === file.id ? file : current));
      setFileActionError(null);
      queryClient.invalidateQueries({ queryKey: ["files", accessToken] });
    },
    onError: (error) => setFileActionError(error instanceof Error ? error.message : "Failed to rename file")
  });

  const deleteFileMutation = useMutation({
    mutationFn: (fileId: string) => deleteFile(accessToken!, fileId),
    onSuccess: (file) => {
      setSelectedFile((current) => (current?.id === file.id ? null : current));
      setFileActionError(null);
      queryClient.invalidateQueries({ queryKey: ["files", accessToken] });
      queryClient.invalidateQueries({ queryKey: ["storage-usage", accessToken] });
    },
    onError: (error) => setFileActionError(error instanceof Error ? error.message : "Failed to delete file")
  });

  useEffect(() => {
    if (!accessToken) return;

    const replay = () => void replayPendingFileChanges();
    replay();
    window.addEventListener("online", replay);
    return () => window.removeEventListener("online", replay);
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) return;

    let cancelled = false;
    let polling = false;
    let cursorReady = false;
    const pollChanges = async () => {
      if (!cursorReady || polling || document.hidden || !navigator.onLine) return;
      polling = true;
      try {
        const changes = await listSyncChanges(accessToken, syncCursorRef.current);
        if (cancelled || changes.length === 0) return;

        syncCursorRef.current = changes.at(-1)?.createdAt ?? new Date().toISOString();
        queryClient.invalidateQueries({ queryKey: ["files", accessToken] });
        queryClient.invalidateQueries({ queryKey: ["storage-usage", accessToken] });
        const currentFile = selectedFileRef.current;
        if (currentFile && changes.some((change) => !change.fileId || change.fileId === currentFile.id)) {
          setSyncPulse((value) => value + 1);
        }
      } catch {
        // Sync polling is opportunistic; direct user actions still surface errors.
      } finally {
        polling = false;
      }
    };

    const initializeCursor = async () => {
      try {
        const state = await getSyncState(accessToken);
        if (!cancelled) {
          syncCursorRef.current = state.cursor;
          cursorReady = true;
          void pollChanges();
        }
      } catch {
        if (!cancelled) cursorReady = true;
      }
    };

    const pollWhenVisible = () => void pollChanges();
    void initializeCursor();
    const interval = window.setInterval(() => void pollChanges(), SYNC_POLL_INTERVAL_MS);
    window.addEventListener("focus", pollWhenVisible);
    window.addEventListener("online", pollWhenVisible);
    document.addEventListener("visibilitychange", pollWhenVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", pollWhenVisible);
      window.removeEventListener("online", pollWhenVisible);
      document.removeEventListener("visibilitychange", pollWhenVisible);
    };
  }, [accessToken, queryClient]);

  useEffect(() => {
    if (!selectedFile || filesQuery.isLoading || !filesQuery.data) return;

    const freshFile = filesQuery.data.find((file) => file.id === selectedFile.id);
    setSelectedFile(freshFile ?? null);
  }, [filesQuery.data, filesQuery.isLoading, selectedFile]);

  function openRenameDialog(file: FileRecord) {
    setRenameTarget(file);
    setRenameValue(file.name);
  }

  async function handleRenameFile(file: FileRecord, nextName: string) {
    const name = nextName.trim();
    if (!name || name === file.name) return;
    setRenameTarget(null);
    applyFileRename(file.id, name);

    if (!navigator.onLine) {
      await queuePendingFileRename(file.id, name);
      return;
    }

    try {
      const updated = await renameFile(accessToken!, file.id, name);
      applyFileRecord(updated);
      setFileActionError(null);
    } catch (error) {
      await queuePendingFileRename(file.id, name);
      setFileActionError(error instanceof Error ? `${error.message}. Rename queued for retry.` : "Rename queued for retry.");
    }
  }

  async function handleDeleteFile(file: FileRecord) {
    setDeleteTarget(null);
    applyFileDelete(file.id);

    if (!navigator.onLine) {
      await queuePendingFileDelete(file.id);
      return;
    }

    try {
      await deleteFile(accessToken!, file.id);
      setFileActionError(null);
      queryClient.invalidateQueries({ queryKey: ["storage-usage", accessToken] });
    } catch (error) {
      await queuePendingFileDelete(file.id);
      setFileActionError(error instanceof Error ? `${error.message}. Delete queued for retry.` : "Delete queued for retry.");
    }
  }

  function applyFileRename(fileId: string, name: string) {
    queryClient.setQueryData<FileRecord[]>(["files", accessToken], (current) => current?.map((file) => (file.id === fileId ? { ...file, name } : file)) ?? current);
    setSelectedFile((current) => (current?.id === fileId ? { ...current, name } : current));
  }

  function applyFileRecord(record: FileRecord) {
    queryClient.setQueryData<FileRecord[]>(["files", accessToken], (current) => current?.map((file) => (file.id === record.id ? record : file)) ?? current);
    setSelectedFile((current) => (current?.id === record.id ? record : current));
  }

  function applyFileDelete(fileId: string) {
    queryClient.setQueryData<FileRecord[]>(["files", accessToken], (current) => current?.filter((file) => file.id !== fileId) ?? current);
    setSelectedFile((current) => (current?.id === fileId ? null : current));
  }

  async function queuePendingFileRename(fileId: string, name: string) {
    await removePendingFileChange(fileId, "update");
    await offlineDb.pendingChanges.add({
      entityType: "file",
      entityId: fileId,
      operation: "update",
      payload: { fileId, name } satisfies PendingFileRenamePayload,
      createdAt: new Date().toISOString()
    });
    setFileSyncStatus("queued");
  }

  async function queuePendingFileDelete(fileId: string) {
    await removePendingFileChange(fileId, "update");
    await removePendingFileChange(fileId, "delete");
    await offlineDb.pendingChanges.add({
      entityType: "file",
      entityId: fileId,
      operation: "delete",
      payload: { fileId } satisfies PendingFileDeletePayload,
      createdAt: new Date().toISOString()
    });
    setFileSyncStatus("queued");
  }

  async function removePendingFileChange(fileId: string, operation: "update" | "delete") {
    const pending = await offlineDb.pendingChanges
      .where("entityType")
      .equals("file")
      .and((change) => change.entityId === fileId && change.operation === operation)
      .toArray();
    await Promise.all(pending.map((change) => (change.id === undefined ? Promise.resolve() : offlineDb.pendingChanges.delete(change.id))));
  }

  async function replayPendingFileChanges() {
    if (!accessToken || !navigator.onLine) return;

    const pending = await offlineDb.pendingChanges
      .where("entityType")
      .equals("file")
      .toArray();
    if (!pending.length) return;

    setFileSyncStatus("syncing");
    try {
      for (const change of pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        if (change.operation === "create") {
          const payload = change.payload as PendingFileUploadPayload;
          const file = new File([payload.data], payload.name, { type: payload.type || "application/pdf", lastModified: payload.lastModified });
          const uploaded = await uploadPdf(accessToken, file);
          setSelectedFile(uploaded);
        } else if (change.operation === "update") {
          const payload = change.payload as PendingFileRenamePayload;
          const updated = await renameFile(accessToken, payload.fileId, payload.name);
          applyFileRecord(updated);
        } else if (change.operation === "delete") {
          const payload = change.payload as PendingFileDeletePayload;
          await deleteFile(accessToken, payload.fileId);
          applyFileDelete(payload.fileId);
        }
        if (change.id !== undefined) await offlineDb.pendingChanges.delete(change.id);
      }
      setFileSyncStatus("idle");
      setFileActionError(null);
      queryClient.invalidateQueries({ queryKey: ["files", accessToken] });
      queryClient.invalidateQueries({ queryKey: ["storage-usage", accessToken] });
    } catch (error) {
      setFileSyncStatus("failed");
      setFileActionError(error instanceof Error ? error.message : "Failed to sync pending file changes");
    }
  }

  async function handleUploadFile(file: File) {
    if (file.type !== "application/pdf") {
      setFileActionError("Only PDF files are supported");
      return;
    }
    if (file.size > MAX_UPLOAD_SIZE_BYTES) {
      setFileActionError("PDF file must be 200MB or smaller");
      return;
    }

    setFileActionError(null);
    if (!navigator.onLine) {
      await queuePendingFileUpload(file);
      return;
    }

    try {
      const uploaded = await uploadPdf(accessToken!, file);
      setSelectedFile(uploaded);
      setFileActionError(null);
      queryClient.invalidateQueries({ queryKey: ["files", accessToken] });
      queryClient.invalidateQueries({ queryKey: ["storage-usage", accessToken] });
    } catch (error) {
      await queuePendingFileUpload(file);
      setFileActionError(error instanceof Error ? `${error.message}. Upload queued for retry.` : "Upload queued for retry.");
    }
  }

  async function queuePendingFileUpload(file: File) {
    await offlineDb.pendingChanges.add({
      entityType: "file",
      entityId: `upload-${crypto.randomUUID()}`,
      operation: "create",
      payload: {
        name: file.name,
        type: file.type,
        lastModified: file.lastModified,
        data: await file.arrayBuffer()
      } satisfies PendingFileUploadPayload,
      createdAt: new Date().toISOString()
    });
    setFileSyncStatus("queued");
    setFileActionError("Upload queued. It will start when you are back online.");
  }

  const files = filesQuery.data ?? [];
  const filteredFiles = fileSearch.trim()
    ? files.filter((file) => file.name.toLowerCase().includes(fileSearch.trim().toLowerCase()))
    : files;

  if (!accessToken) {
    return (
      <main className="auth-shell">
        <section className="auth-panel">
          <p className="eyebrow">PageBridge MVP</p>
          <h1>Read, mark, and continue from anywhere.</h1>
          <p className="lede">This build wires the Web client to the NestJS API, Prisma, PostgreSQL, Redis, and S3-compatible storage foundation.</p>
          <Label>
            Email
            <Input value={email} onChange={(event) => setEmail(event.target.value)} />
          </Label>
          <Label>
            Password
            <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </Label>
          <div className="button-row">
            <Button onClick={() => authMutation.mutate("login")} disabled={authMutation.isPending}>Log in</Button>
            <Button variant="outline" onClick={() => authMutation.mutate("register")} disabled={authMutation.isPending}>Create account</Button>
          </div>
          {authMutation.error ? <p className="error">{authMutation.error.message}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-stack">
          <p className="eyebrow">Signed in</p>
          <h2>{userEmail}</h2>
          {storageUsageQuery.data ? (
            <StorageUsage
              usedBytes={storageUsageQuery.data.usedBytes}
              quotaBytes={storageUsageQuery.data.quotaBytes}
              fileCount={storageUsageQuery.data.fileCount}
              fileCountQuota={storageUsageQuery.data.fileCountQuota}
            />
          ) : null}
        </div>
        <Button variant="outline" onClick={() => logoutMutation.mutate()} disabled={logoutMutation.isPending}>Sign out</Button>
      </aside>

      <section className="library">
        <header className="toolbar">
          <div>
            <p className="eyebrow">Library</p>
            <h1>Your PDFs</h1>
          </div>
          <div className="create-file">
            <Button asChild>
            <Label className="upload-button">
              {uploadMutation.isPending ? "Uploading..." : "Upload PDF"}
              <input
                type="file"
                accept="application/pdf"
                disabled={uploadMutation.isPending}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleUploadFile(file);
                  event.currentTarget.value = "";
                }}
              />
            </Label>
            </Button>
          </div>
        </header>

        <div className="content-grid">
          <section className="file-list">
            <Label className="file-search">
              Search files
              <Input value={fileSearch} onChange={(event) => setFileSearch(event.target.value)} placeholder="Filter by PDF name" />
            </Label>
            {filesQuery.isLoading ? <p>Loading files...</p> : null}
            {fileActionError ? <p className="error">{fileActionError}</p> : null}
            {fileSyncStatus === "queued" || fileSyncStatus === "failed" ? (
              <Button className="retry-button" size="sm" onClick={() => void replayPendingFileChanges()}>Retry file sync</Button>
            ) : null}
            {fileSyncStatus === "syncing" ? <p className="sync-line">File changes syncing...</p> : null}
            {files.length === 0 && !filesQuery.isLoading ? <p>No PDFs yet. Upload one to start reading and annotating.</p> : null}
            {files.length > 0 && filteredFiles.length === 0 ? <p>No PDFs match “{fileSearch}”.</p> : null}
            {filteredFiles.map((file) => (
              <article className={selectedFile?.id === file.id ? "file-row selected" : "file-row"} key={file.id} onClick={() => setSelectedFile(file)}>
                <div>
                  <strong>{file.name}</strong>
                  <span>{formatFileMeta(file)}</span>
                </div>
                <div className="file-actions">
                  <Button
                    variant="link"
                    className="text-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      openRenameDialog(file);
                    }}
                    disabled={renameFileMutation.isPending || deleteFileMutation.isPending}
                  >
                    Rename
                  </Button>
                  <Button
                    variant="link"
                    className="text-button danger"
                    onClick={(event) => {
                      event.stopPropagation();
                      setDeleteTarget(file);
                    }}
                    disabled={renameFileMutation.isPending || deleteFileMutation.isPending}
                  >
                    Delete
                  </Button>
                </div>
              </article>
            ))}
          </section>

          {selectedFile ? (
            <Suspense fallback={<section className="reader-placeholder"><p>Loading reader...</p></section>}>
              <PdfReader token={accessToken} file={selectedFile} syncPulse={syncPulse} />
            </Suspense>
          ) : (
            <section className="reader-placeholder">
              <p className="eyebrow">Reader</p>
              <h2>Select a PDF</h2>
              <p>Choose a file from your library to load the PDF reader.</p>
            </section>
          )}
        </div>
      </section>

      <Dialog open={Boolean(renameTarget)} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent className="app-dialog">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (renameTarget) void handleRenameFile(renameTarget, renameValue);
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename PDF</DialogTitle>
              <DialogDescription>Give this file a clear library name. The PDF itself will not be modified.</DialogDescription>
            </DialogHeader>
            <Label className="dialog-field">
              File name
              <Input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} />
            </Label>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRenameTarget(null)}>Cancel</Button>
              <Button type="submit" disabled={!renameValue.trim() || renameValue.trim() === renameTarget?.name}>Save name</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent className="app-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this PDF?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? `${deleteTarget.name} will be removed from your library. This action can sync to other devices.` : "This file will be removed from your library."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="danger-action" onClick={() => deleteTarget && void handleDeleteFile(deleteTarget)}>Delete PDF</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

function formatFileMeta(file: FileRecord) {
  const size = Number(file.sizeBytes);
  const sizeLabel = Number.isFinite(size) && size > 0 ? `${(size / 1024 / 1024).toFixed(1)} MB` : "Size unknown";
  const pageLabel = file.pageCount ? `${file.pageCount} pages` : "Pages unknown";
  return `${pageLabel} · ${sizeLabel}`;
}

function StorageUsage({ usedBytes, quotaBytes, fileCount, fileCountQuota }: { usedBytes: string; quotaBytes: string; fileCount: number; fileCountQuota: number }) {
  const used = Number(usedBytes);
  const quota = Number(quotaBytes);
  const percent = quota > 0 ? Math.min(100, (used / quota) * 100) : 0;

  return (
    <div className="storage-usage">
      <div className="storage-usage-bar"><span style={{ width: `${percent}%` }} /></div>
      <p>{formatBytes(used)} of {formatBytes(quota)} used</p>
      <p>{fileCount} of {fileCountQuota} files</p>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 1024 * 1024 * 1024 ? 2 : 1)} MB`;
}
