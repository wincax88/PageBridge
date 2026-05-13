import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ArrowLeft, BookOpen, Bookmark, CheckCircle2, ChevronRight, Clock, Cloud, FileText, Grid3X3, HardDrive, Highlighter, Keyboard, List, LogOut, MoreVertical, PenLine, RefreshCcw, Search, Settings, Shield, Star, Trash2, Upload, User } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState, type DragEvent } from "react";
import { Navigate, NavLink, matchPath, useLocation, useNavigate } from "react-router-dom";
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
import { deleteFile, emptyTrash, getStorageUsage, getSyncState, listDeletedFiles, listFiles, listSyncChanges, login, logout, permanentlyDeleteFile, register, renameFile, restoreFile, uploadPdf, type DeletedFileRecord, type FileRecord } from "../lib/api";
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
  const location = useLocation();
  const navigate = useNavigate();
  const syncCursorRef = useRef(new Date().toISOString());
  const selectedFileRef = useRef<FileRecord | null>(null);
  const { accessToken, refreshToken, userEmail, setSession, clearSession } = useAuthStore();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [selectedFile, setSelectedFile] = useState<FileRecord | null>(null);
  const [fileActionError, setFileActionError] = useState<string | null>(null);
  const [fileSyncStatus, setFileSyncStatus] = useState<"idle" | "queued" | "syncing" | "failed">("idle");
  const [fileSearch, setFileSearch] = useState("");
  const [syncPulse, setSyncPulse] = useState(0);
  const [renameTarget, setRenameTarget] = useState<FileRecord | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<FileRecord | null>(null);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [documentView, setDocumentView] = useState<"grid" | "list">("grid");

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
    onSuccess: (session) => {
      setSession(session.accessToken, session.refreshToken, session.user.email);
      navigate("/library", { replace: true });
    }
  });

  const logoutMutation = useMutation({
    mutationFn: () => (refreshToken ? logout(refreshToken) : Promise.resolve({ ok: true })),
    onSettled: () => {
      setSelectedFile(null);
      queryClient.clear();
      clearSession();
      navigate("/login", { replace: true });
    }
  });

  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadPdf(accessToken!, file),
    onSuccess: (file) => {
      setSelectedFile(file);
      navigate(`/reader/${file.id}`);
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
    if (routeFileId === fileId) navigate("/library");
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
      navigate(`/reader/${uploaded.id}`);
      setFileActionError(null);
      queryClient.invalidateQueries({ queryKey: ["files", accessToken] });
      queryClient.invalidateQueries({ queryKey: ["storage-usage", accessToken] });
    } catch (error) {
      await queuePendingFileUpload(file);
      setFileActionError(error instanceof Error ? `${error.message}. Upload queued for retry.` : "Upload queued for retry.");
    }
  }

  function handleUploadDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (!file) return;
    setUploadDialogOpen(false);
    void handleUploadFile(file);
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
  const readerMatch = matchPath("/reader/:fileId", location.pathname);
  const routeFileId = readerMatch?.params.fileId;
  const routeSelectedFile = routeFileId ? files.find((file) => file.id === routeFileId) ?? null : null;
  const activeFile = routeSelectedFile ?? selectedFile;
  const filteredFiles = fileSearch.trim()
    ? files.filter((file) => file.name.toLowerCase().includes(fileSearch.trim().toLowerCase()))
    : files;
  const isFavoritesRoute = location.pathname === "/favorites";
  const visibleFiles = isFavoritesRoute ? filteredFiles.slice(1, 2) : filteredFiles;
  const effectiveDocumentView = documentView;
  const pageTitle = getPageTitle(location.pathname);

  if (!accessToken) {
    if (location.pathname !== "/login") return <Navigate to="/login" replace />;
    return (
      <main className="auth-shell">
        <section className="auth-brand-panel" aria-label="阅迹产品介绍">
          <div className="auth-brand-content">
            <div className="auth-logo-row">
              <div className="brand-mark"><FileText size={24} strokeWidth={2.2} /></div>
              <span>阅迹</span>
            </div>
            <h1>跨平台 PDF 阅读、标注与同步工具</h1>
            <ul>
              <li><FileText size={18} />PDF 在线阅读</li>
              <li><Highlighter size={18} />高亮、批注、笔记</li>
              <li><RefreshCcw size={18} />多端同步阅读进度</li>
              <li><Cloud size={18} />云端保存标注</li>
            </ul>
          </div>
        </section>
        <section className="auth-panel">
          <div className="auth-form">
            <header>
              <h1>登录阅迹</h1>
              <p className="lede">继续阅读你的 PDF 与标注</p>
            </header>
            <Label>
              邮箱
              <Input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="your@email.com" />
            </Label>
            <Label>
              密码
              <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入密码" />
            </Label>
            <Button className="auth-submit" onClick={() => authMutation.mutate("login")} disabled={authMutation.isPending}>登录</Button>
            <div className="auth-links">
              <Button variant="link" onClick={() => authMutation.mutate("register")} disabled={authMutation.isPending}>创建账号</Button>
              <button className="forgot-link" type="button">忘记密码？</button>
            </div>
            {authMutation.error ? <p className="error">{authMutation.error.message}</p> : null}
          </div>
        </section>
      </main>
    );
  }

  if (location.pathname === "/" || location.pathname === "/login") return <Navigate to="/library" replace />;

  if (readerMatch) {
    return activeFile ? (
      <main className="reader-route-shell">
        <Suspense fallback={<section className="reader-placeholder"><p>正在加载阅读器...</p></section>}>
          <PdfReader token={accessToken} file={activeFile} syncPulse={syncPulse} />
        </Suspense>
      </main>
    ) : (
      <main className="reader-route-shell">
        <section className="reader-placeholder missing-reader">
          <p className="eyebrow">阅读器</p>
          <h2>未找到 PDF</h2>
          <p>请返回文件库选择一个 PDF，或上传新的文档。</p>
          <Button onClick={() => navigate("/library")}>返回文件库</Button>
        </section>
      </main>
    );
  }

  if (location.pathname === "/settings") {
    return (
      <SettingsPage
        userEmail={userEmail}
        usedBytes={storageUsageQuery.data?.usedBytes}
        quotaBytes={storageUsageQuery.data?.quotaBytes}
        fileCount={storageUsageQuery.data?.fileCount}
        fileCountQuota={storageUsageQuery.data?.fileCountQuota}
        onBack={() => navigate("/library")}
        onLogout={() => logoutMutation.mutate()}
        logoutPending={logoutMutation.isPending}
      />
    );
  }

  if (location.pathname === "/trash") {
    return <TrashPage token={accessToken} onBack={() => navigate("/library")} />;
  }

  return (
    <main className={location.pathname === "/settings" ? "app-shell route-settings" : "app-shell"}>
      <header className="toolbar">
        <Label className="global-search">
          <span className="sr-only">搜索</span>
          <Search size={22} aria-hidden="true" />
          <Input value={fileSearch} onChange={(event) => setFileSearch(event.target.value)} placeholder="搜索文件、标注或笔记" />
        </Label>
        <div className="toolbar-status"><CheckCircle2 size={18} /> 已同步</div>
        <div className="create-file">
          <Button onClick={() => setUploadDialogOpen(true)} disabled={uploadMutation.isPending}><Upload size={16} />{uploadMutation.isPending ? "正在上传..." : "上传 PDF"}</Button>
        </div>
        <div className="avatar" aria-hidden="true">A</div>
      </header>

      <aside className="sidebar">
        <div className="sidebar-stack">
          <div className="brand-block">
            <div className="brand-mark small"><FileText size={20} /></div>
            <h2>阅迹</h2>
          </div>
          <nav className="sidebar-nav" aria-label="Primary">
            <div>
              <p>文档</p>
              <NavLink to="/library"><FileText size={16} />我的文档</NavLink>
              <NavLink to="/recent"><Clock size={16} />最近阅读</NavLink>
              <NavLink to="/favorites"><Star size={16} />收藏文档</NavLink>
              <NavLink to="/annotations"><PenLine size={16} />我的标注</NavLink>
            </div>
            <div>
              <p>管理</p>
              <NavLink to="/trash"><Trash2 size={16} />回收站</NavLink>
              <NavLink to="/settings"><Settings size={16} />设置</NavLink>
            </div>
          </nav>
          {storageUsageQuery.data ? (
            <StorageUsage
              usedBytes={storageUsageQuery.data.usedBytes}
              quotaBytes={storageUsageQuery.data.quotaBytes}
              fileCount={storageUsageQuery.data.fileCount}
              fileCountQuota={storageUsageQuery.data.fileCountQuota}
            />
          ) : null}
        </div>
      </aside>

      <section className={`library route-${location.pathname.slice(1) || "library"}`}>
        {location.pathname === "/library" ? (
          <div className="mobile-library-head">
            <header>
              <h1>阅迹</h1>
              <div className="mobile-avatar">U</div>
            </header>
            <Label className="mobile-search">
              <Search size={20} aria-hidden="true" />
              <Input value={fileSearch} onChange={(event) => setFileSearch(event.target.value)} placeholder="搜索文件、标注或笔记" />
            </Label>
            <section className="mobile-recent-card">
              <p>最近阅读</p>
              <article>
                <strong>论文阅读.pdf</strong>
                <span>第 8 / 56 页</span>
                <span>上次阅读：今天 10:24</span>
                <span>标注 16 条</span>
                <Button onClick={() => filteredFiles[0] && navigate(`/reader/${filteredFiles[0].id}`)}>继续阅读</Button>
              </article>
            </section>
          </div>
        ) : null}
        {location.pathname === "/recent" ? <MobileRecentPage onOpen={() => filteredFiles[0] && navigate(`/reader/${filteredFiles[0].id}`)} /> : null}
        {location.pathname === "/annotations" ? <MobileAnnotationsPage /> : null}
        <div className={location.pathname === "/settings" ? "content-grid library-grid-mode settings-route-mode" : "content-grid library-grid-mode"}>
          <section className={`file-list ${effectiveDocumentView === "list" ? "list-view" : "grid-view"}`}>
            <header className="library-heading">
              <h1>{pageTitle}</h1>
              <Button className="mobile-upload-button" variant="ghost" onClick={() => setUploadDialogOpen(true)}><Upload size={16} />上传 PDF</Button>
              <div className="view-toggle" aria-label="切换文档视图">
                <button className={effectiveDocumentView === "grid" ? "active" : ""} type="button" onClick={() => setDocumentView("grid")} aria-label="网格视图"><Grid3X3 size={18} /></button>
                <button className={effectiveDocumentView === "list" ? "active" : ""} type="button" onClick={() => setDocumentView("list")} aria-label="列表视图"><List size={18} /></button>
              </div>
            </header>
            {filesQuery.isLoading ? <p>正在加载文件...</p> : null}
            {fileActionError ? <p className="error">{fileActionError}</p> : null}
            {fileSyncStatus === "queued" || fileSyncStatus === "failed" ? (
              <Button className="retry-button" size="sm" onClick={() => void replayPendingFileChanges()}>重试文件同步</Button>
            ) : null}
            {fileSyncStatus === "syncing" ? <p className="sync-line">文件变更同步中...</p> : null}
            {files.length === 0 && !filesQuery.isLoading ? <EmptyLibrary onUpload={() => setUploadDialogOpen(true)} /> : null}
            {files.length > 0 && visibleFiles.length === 0 ? <p>没有匹配“{fileSearch}”的 PDF。</p> : null}
            {visibleFiles.map((file) => (
              <article className={activeFile?.id === file.id ? "file-card selected" : "file-card"} key={file.id} onClick={() => {
                setSelectedFile(file);
                navigate(`/reader/${file.id}`);
              }}>
                <div className="pdf-cover" aria-hidden="true"><FileText size={effectiveDocumentView === "list" ? 28 : 64} strokeWidth={2.2} /></div>
                <div className="file-card-body">
                  <strong>{file.name}</strong>
                  {effectiveDocumentView === "grid" ? (
                    <>
                      <span>{formatFileMeta(file)}</span>
                      <span>最近阅读：第 1 页</span>
                      <span>标注：0 条</span>
                    </>
                  ) : (
                    <span>{formatFileMeta(file)} · 最近阅读：第 1 页 · 标注：0 条</span>
                  )}
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
                    重命名
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
                    删除
                  </Button>
                </div>
                <Button className="continue-button" size="sm" onClick={(event) => {
                  event.stopPropagation();
                  setSelectedFile(file);
                  navigate(`/reader/${file.id}`);
                }}>继续阅读</Button>
                <button className="more-button" type="button" aria-label="更多操作" onClick={(event) => event.stopPropagation()}><MoreVertical size={18} /></button>
              </article>
            ))}
          </section>

        </div>
      </section>

      <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
        <DialogContent className="app-dialog upload-dialog">
          <DialogHeader>
            <DialogTitle>上传 PDF</DialogTitle>
            <DialogDescription>选择电脑中的 PDF 文件，最大支持 200MB。</DialogDescription>
          </DialogHeader>
          <Label
            className="upload-dropzone"
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleUploadDrop}
          >
            <span>从文件中选择 PDF</span>
            <small>或点击选择文件</small>
            <em>支持 .pdf，最大 200MB</em>
            <input
              type="file"
              accept="application/pdf"
              disabled={uploadMutation.isPending}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  setUploadDialogOpen(false);
                  void handleUploadFile(file);
                }
                event.currentTarget.value = "";
              }}
            />
          </Label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setUploadDialogOpen(false)}>取消</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(renameTarget)} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent className="app-dialog">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (renameTarget) void handleRenameFile(renameTarget, renameValue);
            }}
          >
            <DialogHeader>
              <DialogTitle>重命名 PDF</DialogTitle>
              <DialogDescription>为文件设置清晰的资料库名称，不会修改 PDF 原文件。</DialogDescription>
            </DialogHeader>
            <Label className="dialog-field">
              文件名
              <Input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} />
            </Label>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRenameTarget(null)}>取消</Button>
              <Button type="submit" disabled={!renameValue.trim() || renameValue.trim() === renameTarget?.name}>保存名称</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent className="app-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>删除这个 PDF？</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? `${deleteTarget.name} 将从文件库移除，并同步到其他设备。` : "该文件将从文件库移除。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction className="danger-action" onClick={() => deleteTarget && void handleDeleteFile(deleteTarget)}>删除 PDF</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <nav className="mobile-tabbar" aria-label="Mobile navigation">
        <NavLink to="/library"><FileText size={20} />文档</NavLink>
        <NavLink to="/recent"><Clock size={20} />最近</NavLink>
        <NavLink to="/annotations"><Bookmark size={20} />标注</NavLink>
        <NavLink to="/settings"><User size={20} />我的</NavLink>
      </nav>
    </main>
  );
}

type SettingsTab = "account" | "storage" | "sync" | "reading" | "shortcuts" | "security";

function SettingsPage({
  userEmail,
  usedBytes,
  quotaBytes,
  fileCount,
  fileCountQuota,
  onBack,
  onLogout,
  logoutPending
}: {
  userEmail: string | null;
  usedBytes?: string;
  quotaBytes?: string;
  fileCount?: number;
  fileCountQuota?: number;
  onBack: () => void;
  onLogout: () => void;
  logoutPending: boolean;
}) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("account");
  const initials = userEmail?.slice(0, 1).toUpperCase() || "A";
  const used = Number(usedBytes ?? 238 * 1024 * 1024);
  const quota = Number(quotaBytes ?? 2 * 1024 * 1024 * 1024);
  const storagePercent = quota > 0 ? Math.min(100, (used / quota) * 100) : 0;
  const displayFileCount = fileCount ?? 24;
  const displayFileCountQuota = fileCountQuota ?? 100;
  const tabs: Array<{ id: SettingsTab; label: string; icon: typeof User }> = [
    { id: "account", label: "账号信息", icon: User },
    { id: "storage", label: "存储空间", icon: HardDrive },
    { id: "sync", label: "同步设置", icon: RefreshCcw },
    { id: "reading", label: "阅读设置", icon: BookOpen },
    { id: "shortcuts", label: "快捷键", icon: Keyboard },
    { id: "security", label: "安全设置", icon: Shield }
  ];

  return (
    <main className="settings-shell">
      <section className="mobile-mine-page">
        <h1>我的</h1>
        <article className="mobile-profile-card">
          <div className="mobile-profile-avatar">{initials}</div>
          <div><strong>用户昵称</strong><span>{userEmail || "user@email.com"}</span></div>
        </article>
        <article className="mobile-storage-card">
          <span>存储空间</span>
          <strong>238MB / 2GB</strong>
          <div><span /></div>
        </article>
        <nav className="mobile-settings-list">
          <button type="button">阅读设置<ChevronRight size={20} /></button>
          <button type="button">同步设置<ChevronRight size={20} /></button>
          <button type="button">账号安全<ChevronRight size={20} /></button>
          <button type="button">关于阅迹<ChevronRight size={20} /></button>
        </nav>
        <Button className="mobile-logout-button" variant="outline" onClick={onLogout} disabled={logoutPending}><LogOut size={18} />退出登录</Button>
        <nav className="mobile-tabbar" aria-label="Mobile navigation">
          <NavLink to="/library"><FileText size={20} />文档</NavLink>
          <NavLink to="/recent"><Clock size={20} />最近</NavLink>
          <NavLink to="/annotations"><Bookmark size={20} />标注</NavLink>
          <NavLink to="/settings"><User size={20} />我的</NavLink>
        </nav>
      </section>
      <header className="settings-topbar">
        <button type="button" onClick={onBack}><ArrowLeft size={18} />返回文件库</button>
        <h1>设置</h1>
      </header>
      <div className="settings-layout">
        <nav className="settings-menu" aria-label="设置分类">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button className={activeTab === tab.id ? "active" : ""} key={tab.id} type="button" onClick={() => setActiveTab(tab.id)}>
                <Icon size={18} />
                {tab.label}
              </button>
            );
          })}
        </nav>

        <section className="settings-panel">
          {activeTab === "account" ? (
            <>
              <h2>账号信息</h2>
              <div className="account-edit-row">
                <div className="settings-avatar" aria-hidden="true">{initials}</div>
                <Button variant="outline">更换头像</Button>
              </div>
              <Label>昵称<Input value="用户名" readOnly /></Label>
              <Label>邮箱<Input value={userEmail || "user@example.com"} readOnly /></Label>
              <Button className="settings-outline-button" variant="outline">修改密码</Button>
              <div className="settings-divider" />
              <Button className="danger-outline-button" variant="outline" onClick={onLogout} disabled={logoutPending}><LogOut size={16} />退出登录</Button>
            </>
          ) : null}

          {activeTab === "storage" ? (
            <>
              <h2>存储空间</h2>
              <div className="storage-panel-card">
                <p><strong>{formatBytes(used)}</strong><span>/ {formatBytes(quota)}</span></p>
                <div className="storage-usage-bar"><span style={{ width: `${storagePercent}%` }} /></div>
                <div className="storage-stats">
                  <span>文件数量<strong>{displayFileCount} 个</strong></span>
                  <span>标注数量<strong>318 条</strong></span>
                </div>
              </div>
              <Button>升级存储空间</Button>
              <span className="settings-muted">文件配额 {displayFileCount} / {displayFileCountQuota}</span>
            </>
          ) : null}

          {activeTab === "sync" ? (
            <>
              <h2>同步设置</h2>
              <SettingsToggle title="自动同步标注" detail="自动将标注同步到云端" />
              <SettingsToggle title="自动同步阅读进度" detail="记录并同步当前阅读位置" />
              <SettingsToggle title="离线缓存最近打开文件" detail="在离线状态下也能阅读" />
            </>
          ) : null}

          {activeTab === "reading" ? (
            <>
              <h2>阅读设置</h2>
              <Label>默认缩放<select><option>适应宽度</option><option>适应页面</option><option>100%</option></select></Label>
              <Label>默认阅读模式<select><option>连续滚动</option><option>单页阅读</option><option>双页阅读</option></select></Label>
              <SettingsToggle title="默认打开右侧标注面板" detail="进入阅读器时自动显示标注面板" />
            </>
          ) : null}

          {activeTab === "shortcuts" ? (
            <>
              <h2>快捷键</h2>
              <ShortcutRow label="搜索" value="Ctrl + F" />
              <ShortcutRow label="放大" value="Ctrl + +" />
              <ShortcutRow label="缩小" value="Ctrl + -" />
              <ShortcutRow label="高亮" value="H" />
              <ShortcutRow label="添加批注" value="N" />
              <ShortcutRow label="关闭弹窗 / 取消选择" value="Esc" />
              <ShortcutRow label="上一页" value="←" />
              <ShortcutRow label="下一页" value="→" />
            </>
          ) : null}

          {activeTab === "security" ? (
            <>
              <h2>安全设置</h2>
              <div className="security-actions">
                <Button variant="outline">修改密码</Button>
                <Button variant="outline">查看登录设备</Button>
              </div>
              <div className="settings-divider" />
              <div className="danger-zone">
                <strong>危险操作</strong>
                <Button className="danger-outline-button" variant="outline">删除账号</Button>
              </div>
            </>
          ) : null}
        </section>
      </div>
    </main>
  );
}

function SettingsToggle({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="settings-toggle-row">
      <div><strong>{title}</strong><span>{detail}</span></div>
      <button className="switch active" type="button" aria-label={title}><span /></button>
    </div>
  );
}

function ShortcutRow({ label, value }: { label: string; value: string }) {
  return <div className="shortcut-row"><span>{label}</span><kbd>{value}</kbd></div>;
}

function MobileRecentPage({ onOpen }: { onOpen: () => void }) {
  return (
    <section className="mobile-simple-page mobile-recent-page">
      <h1>最近阅读</h1>
      <MobileContinueCard title="论文阅读.pdf" page="第 8 / 56 页" time="上次阅读：今天 10:24" notes="标注 16 条" onOpen={onOpen} />
      <MobileContinueCard title="产品需求.pdf" page="第 12 / 24 页" time="上次阅读：昨天 15:30" notes="标注 8 条" onOpen={onOpen} />
    </section>
  );
}

function MobileContinueCard({ title, page, time, notes, onOpen }: { title: string; page: string; time: string; notes: string; onOpen: () => void }) {
  return (
    <article className="mobile-continue-card">
      <strong>{title}</strong>
      <span>{page}</span>
      <span>{time}</span>
      <span>{notes}</span>
      <Button onClick={onOpen}>继续阅读</Button>
    </article>
  );
}

function MobileAnnotationsPage() {
  return (
    <section className="mobile-simple-page mobile-annotations-page">
      <h1>我的标注</h1>
      <Label className="mobile-search annotation-mobile-search">
        <Search size={20} aria-hidden="true" />
        <Input placeholder="搜索标注或笔记" />
      </Label>
      <div className="mobile-chip-row">
        <button className="active" type="button">全部</button>
        <button type="button">高亮</button>
        <button type="button">批注</button>
        <button type="button">书签</button>
      </div>
      <MobileAnnotationCard title="论文阅读.pdf · 第 8 页 · 高亮" highlight="这是一段被高亮的原文，包含了核心观点和重要内容..." note="这里是重点" synced />
      <MobileAnnotationCard title="产品需求.pdf · 第 12 页 · 批注" highlight="关键功能需求说明..." note="需要重点关注的功能点" />
    </section>
  );
}

function MobileAnnotationCard({ title, highlight, note, synced }: { title: string; highlight: string; note: string; synced?: boolean }) {
  return (
    <article className="mobile-annotation-card">
      <header><span>{title}</span><MoreVertical size={18} /></header>
      <mark>{highlight}</mark>
      <p>备注：{note}</p>
      <small>{synced ? "✓ 已同步" : "◌ 同步中..."}</small>
    </article>
  );
}

function TrashPage({ token, onBack }: { token: string; onBack: () => void }) {
  const queryClient = useQueryClient();
  const trashQuery = useQuery({ queryKey: ["trash", token], queryFn: () => listDeletedFiles(token) });
  const restoreMutation = useMutation({
    mutationFn: (fileId: string) => restoreFile(token, fileId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["trash", token] });
      queryClient.invalidateQueries({ queryKey: ["files", token] });
      queryClient.invalidateQueries({ queryKey: ["storage-usage", token] });
    }
  });
  const permanentDeleteMutation = useMutation({
    mutationFn: (fileId: string) => permanentlyDeleteFile(token, fileId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["trash", token] });
      queryClient.invalidateQueries({ queryKey: ["storage-usage", token] });
    }
  });
  const emptyTrashMutation = useMutation({
    mutationFn: () => emptyTrash(token),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["trash", token] });
      queryClient.invalidateQueries({ queryKey: ["storage-usage", token] });
    }
  });
  const deletedFiles = trashQuery.data ?? [];

  return (
    <main className="trash-shell">
      <header className="trash-topbar">
        <button type="button" onClick={onBack}><ArrowLeft size={18} />返回文件库</button>
      </header>
      <section className="trash-content">
        <header className="trash-heading">
          <h1>回收站</h1>
          <p>文件在回收站中保留 30 天，之后将被永久删除</p>
        </header>

        <div className="trash-table">
          <div className="trash-table-head">
            <label><input type="checkbox" />共 {deletedFiles.length} 个文件</label>
            <Button className="danger-outline-button" variant="outline" onClick={() => emptyTrashMutation.mutate()} disabled={deletedFiles.length === 0 || emptyTrashMutation.isPending}>清空回收站</Button>
          </div>
          {trashQuery.isLoading ? <p className="trash-state">正在加载回收站...</p> : null}
          {trashQuery.error ? <p className="trash-state error">加载回收站失败</p> : null}
          {!trashQuery.isLoading && deletedFiles.length === 0 ? <p className="trash-state">回收站为空</p> : null}
          {deletedFiles.map((file) => (
            <article className="trash-row" key={file.id}>
              <input type="checkbox" aria-label={`选择 ${file.name}`} />
              <div className="trash-file-icon"><FileText size={28} /></div>
              <div className="trash-file-info">
                <strong>{file.name}</strong>
                <span>{formatFileMeta(file)} <i>·</i> <Clock size={14} /> {formatDeletedAt(file)}</span>
              </div>
              <div className="trash-actions">
                <Button variant="outline" onClick={() => restoreMutation.mutate(file.id)} disabled={restoreMutation.isPending}>恢复</Button>
                <Button className="danger-outline-button" variant="outline" onClick={() => permanentDeleteMutation.mutate(file.id)} disabled={permanentDeleteMutation.isPending}>永久删除</Button>
              </div>
            </article>
          ))}
        </div>

        <div className="trash-warning">
          <AlertCircle size={18} />
          <p>回收站中的文件将在 30 天后自动永久删除，且无法恢复。<br />永久删除的文件将释放存储空间，但所有标注和阅读进度也会一并删除。</p>
        </div>
      </section>
    </main>
  );
}

function formatDeletedAt(file: DeletedFileRecord) {
  const deletedAt = new Date(file.deletedAt).getTime();
  if (!Number.isFinite(deletedAt)) return "删除时间未知";
  const days = Math.max(0, Math.floor((Date.now() - deletedAt) / (24 * 60 * 60 * 1000)));
  if (days === 0) return "今天删除";
  return `删除于 ${days} 天前`;
}

function formatFileMeta(file: FileRecord) {
  const size = Number(file.sizeBytes);
  const sizeLabel = Number.isFinite(size) && size > 0 ? `${(size / 1024 / 1024).toFixed(1)} MB` : "大小未知";
  const pageLabel = file.pageCount ? `${file.pageCount} 页` : "页数未知";
  return `${pageLabel} · ${sizeLabel}`;
}

function getPageTitle(pathname: string) {
  if (pathname === "/recent") return "最近阅读";
  if (pathname === "/favorites") return "收藏文档";
  if (pathname === "/annotations") return "我的标注";
  if (pathname === "/trash") return "回收站";
  if (pathname === "/settings") return "设置";
  return "我的文档";
}

function EmptyLibrary({ onUpload }: { onUpload: () => void }) {
  return (
    <div className="empty-library">
      <div className="empty-file-icon">PDF</div>
      <h2>还没有 PDF 文件</h2>
      <p>上传你的第一份 PDF，开始阅读和标注。</p>
      <Button onClick={onUpload}>上传 PDF</Button>
    </div>
  );
}

function StorageUsage({ usedBytes, quotaBytes, fileCount, fileCountQuota }: { usedBytes: string; quotaBytes: string; fileCount: number; fileCountQuota: number }) {
  const used = Number(usedBytes);
  const quota = Number(quotaBytes);
  const percent = quota > 0 ? Math.min(100, (used / quota) * 100) : 0;

  return (
    <div className="storage-usage">
      <p>存储空间</p>
      <strong>已用 {formatBytes(used)} / {formatBytes(quota)}</strong>
      <div className="storage-usage-bar"><span style={{ width: `${percent}%` }} /></div>
      <span>{fileCount} / {fileCountQuota} 个文件</span>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 1024 * 1024 * 1024 ? 2 : 1)} MB`;
}
