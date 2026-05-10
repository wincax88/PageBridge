import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { deleteFile, listFiles, listSyncChanges, login, logout, register, renameFile, uploadPdf, type FileRecord } from "../lib/api";
import { useAuthStore } from "../store/auth-store";

const PdfReader = lazy(() => import("./PdfReader"));

export function App() {
  const queryClient = useQueryClient();
  const syncCursorRef = useRef(new Date().toISOString());
  const selectedFileRef = useRef<FileRecord | null>(null);
  const { accessToken, refreshToken, userEmail, setSession, clearSession } = useAuthStore();
  const [email, setEmail] = useState("demo@pagebridge.dev");
  const [password, setPassword] = useState("pagebridge123");
  const [selectedFile, setSelectedFile] = useState<FileRecord | null>(null);
  const [fileActionError, setFileActionError] = useState<string | null>(null);
  const [fileSearch, setFileSearch] = useState("");
  const [syncPulse, setSyncPulse] = useState(0);

  useEffect(() => {
    selectedFileRef.current = selectedFile;
  }, [selectedFile]);

  const filesQuery = useQuery({
    queryKey: ["files", accessToken],
    queryFn: () => listFiles(accessToken!),
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
      queryClient.invalidateQueries({ queryKey: ["files", accessToken] });
    }
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
    },
    onError: (error) => setFileActionError(error instanceof Error ? error.message : "Failed to delete file")
  });

  useEffect(() => {
    if (!accessToken) return;

    let cancelled = false;
    const pollChanges = async () => {
      try {
        const changes = await listSyncChanges(accessToken, syncCursorRef.current);
        if (cancelled || changes.length === 0) return;

        syncCursorRef.current = changes.at(-1)?.createdAt ?? new Date().toISOString();
        queryClient.invalidateQueries({ queryKey: ["files", accessToken] });
        const currentFile = selectedFileRef.current;
        if (currentFile && changes.some((change) => !change.fileId || change.fileId === currentFile.id)) {
          setSyncPulse((value) => value + 1);
        }
      } catch {
        // Sync polling is opportunistic; direct user actions still surface errors.
      }
    };

    const interval = window.setInterval(() => void pollChanges(), 15000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [accessToken, queryClient]);

  useEffect(() => {
    if (!selectedFile || filesQuery.isLoading || !filesQuery.data) return;

    const freshFile = filesQuery.data.find((file) => file.id === selectedFile.id);
    setSelectedFile(freshFile ?? null);
  }, [filesQuery.data, filesQuery.isLoading, selectedFile]);

  function handleRenameFile(file: FileRecord) {
    const name = window.prompt("Rename PDF", file.name)?.trim();
    if (!name || name === file.name) return;
    renameFileMutation.mutate({ fileId: file.id, name });
  }

  function handleDeleteFile(file: FileRecord) {
    if (!window.confirm(`Delete ${file.name}? This removes it from your library.`)) return;
    deleteFileMutation.mutate(file.id);
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
          <label>
            Email
            <input value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          <div className="button-row">
            <button onClick={() => authMutation.mutate("login")} disabled={authMutation.isPending}>Log in</button>
            <button className="secondary" onClick={() => authMutation.mutate("register")} disabled={authMutation.isPending}>Create account</button>
          </div>
          {authMutation.error ? <p className="error">{authMutation.error.message}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Signed in</p>
          <h2>{userEmail}</h2>
        </div>
        <button className="secondary" onClick={() => logoutMutation.mutate()} disabled={logoutMutation.isPending}>Sign out</button>
      </aside>

      <section className="library">
        <header className="toolbar">
          <div>
            <p className="eyebrow">Library</p>
            <h1>Your PDFs</h1>
          </div>
          <div className="create-file">
            <label className="upload-button">
              Upload PDF
              <input
                type="file"
                accept="application/pdf"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) uploadMutation.mutate(file);
                  event.currentTarget.value = "";
                }}
              />
            </label>
          </div>
        </header>

        <div className="content-grid">
          <section className="file-list">
            <label className="file-search">
              Search files
              <input value={fileSearch} onChange={(event) => setFileSearch(event.target.value)} placeholder="Filter by PDF name" />
            </label>
            {filesQuery.isLoading ? <p>Loading files...</p> : null}
            {fileActionError ? <p className="error">{fileActionError}</p> : null}
            {files.length === 0 && !filesQuery.isLoading ? <p>No PDFs yet. Upload one to start reading and annotating.</p> : null}
            {files.length > 0 && filteredFiles.length === 0 ? <p>No PDFs match “{fileSearch}”.</p> : null}
            {filteredFiles.map((file) => (
              <article className={selectedFile?.id === file.id ? "file-row selected" : "file-row"} key={file.id} onClick={() => setSelectedFile(file)}>
                <div>
                  <strong>{file.name}</strong>
                  <span>{formatFileMeta(file)}</span>
                </div>
                <div className="file-actions">
                  <button
                    className="text-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleRenameFile(file);
                    }}
                    disabled={renameFileMutation.isPending || deleteFileMutation.isPending}
                  >
                    Rename
                  </button>
                  <button
                    className="text-button danger"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleDeleteFile(file);
                    }}
                    disabled={renameFileMutation.isPending || deleteFileMutation.isPending}
                  >
                    Delete
                  </button>
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
    </main>
  );
}

function formatFileMeta(file: FileRecord) {
  const size = Number(file.sizeBytes);
  const sizeLabel = Number.isFinite(size) && size > 0 ? `${(size / 1024 / 1024).toFixed(1)} MB` : "Size unknown";
  const pageLabel = file.pageCount ? `${file.pageCount} pages` : "Pages unknown";
  return `${pageLabel} · ${sizeLabel}`;
}
