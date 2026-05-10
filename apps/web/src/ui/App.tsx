import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { createFile, listFiles, login, register } from "../lib/api";
import { useAuthStore } from "../store/auth-store";

export function App() {
  const queryClient = useQueryClient();
  const { accessToken, userEmail, setSession, clearSession } = useAuthStore();
  const [email, setEmail] = useState("demo@pagebridge.dev");
  const [password, setPassword] = useState("pagebridge123");
  const [fileName, setFileName] = useState("sample-paper.pdf");

  const filesQuery = useQuery({
    queryKey: ["files", accessToken],
    queryFn: () => listFiles(accessToken!),
    enabled: Boolean(accessToken)
  });

  const authMutation = useMutation({
    mutationFn: async (mode: "login" | "register") => (mode === "login" ? login(email, password) : register(email, password)),
    onSuccess: (session) => setSession(session.accessToken, session.user.email)
  });

  const createFileMutation = useMutation({
    mutationFn: () => createFile(accessToken!, fileName),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["files", accessToken] })
  });

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
        <button className="secondary" onClick={clearSession}>Sign out</button>
      </aside>

      <section className="library">
        <header className="toolbar">
          <div>
            <p className="eyebrow">Library</p>
            <h1>Your PDFs</h1>
          </div>
          <div className="create-file">
            <input value={fileName} onChange={(event) => setFileName(event.target.value)} />
            <button onClick={() => createFileMutation.mutate()} disabled={createFileMutation.isPending}>Add placeholder</button>
          </div>
        </header>

        <div className="content-grid">
          <section className="file-list">
            {filesQuery.isLoading ? <p>Loading files...</p> : null}
            {filesQuery.data?.length === 0 ? <p>No PDFs yet. Add a placeholder record or wire the upload flow next.</p> : null}
            {filesQuery.data?.map((file) => (
              <article className="file-row" key={file.id}>
                <strong>{file.name}</strong>
                <span>{file.pageCount ?? "Unknown"} pages</span>
              </article>
            ))}
          </section>

          <section className="reader-placeholder">
            <p className="eyebrow">Reader</p>
            <h2>PDF.js integration point</h2>
            <p>Next step: render selected file pages here, then mount SVG annotations over the text layer.</p>
          </section>
        </div>
      </section>
    </main>
  );
}
