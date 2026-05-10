import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { downloadPdf, getReadingProgress, saveReadingProgress, type FileRecord } from "../lib/api";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

interface PdfReaderProps {
  token: string;
  file: FileRecord | null;
}

export function PdfReader({ token, file }: PdfReaderProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null);
  const restoredFileIdRef = useRef<string | null>(null);
  const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "synced" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadPdf() {
      if (!file) return;
      setIsLoading(true);
      setError(null);
      setPdf(null);
      setPageNumber(1);
      restoredFileIdRef.current = null;

      try {
        const data = await downloadPdf(token, file.id);
        const document = await pdfjs.getDocument({ data }).promise;
        if (!cancelled) setPdf(document);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load PDF");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void loadPdf();
    return () => {
      cancelled = true;
    };
  }, [file, token]);

  useEffect(() => {
    let cancelled = false;

    async function restoreProgress() {
      if (!file || !pdf || restoredFileIdRef.current === file.id) return;
      restoredFileIdRef.current = file.id;

      try {
        const progress = await getReadingProgress(token, file.id);
        if (!cancelled && progress?.page) {
          setPageNumber(Math.min(Math.max(1, progress.page), pdf.numPages));
        }
      } catch {
        if (!cancelled) setSyncStatus("failed");
      }
    }

    void restoreProgress();
    return () => {
      cancelled = true;
    };
  }, [file, pdf, token]);

  useEffect(() => {
    let cancelled = false;

    async function renderPage() {
      if (!pdf || !canvasRef.current) return;

      renderTaskRef.current?.cancel();
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.35 });
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d");
      if (!context) return;

      canvas.width = viewport.width;
      canvas.height = viewport.height;

      const task = page.render({ canvasContext: context, viewport });
      renderTaskRef.current = task;

      try {
        await task.promise;
      } catch (err) {
        if (!cancelled && !(err instanceof Error && err.name === "RenderingCancelledException")) {
          setError(err instanceof Error ? err.message : "Failed to render page");
        }
      }
    }

    void renderPage();
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
    };
  }, [pageNumber, pdf]);

  useEffect(() => {
    if (!file || !pdf || restoredFileIdRef.current !== file.id) return;

    const timeout = window.setTimeout(() => {
      setSyncStatus("syncing");
      saveReadingProgress(token, file.id, pageNumber)
        .then(() => setSyncStatus("synced"))
        .catch(() => setSyncStatus("failed"));
    }, 350);

    return () => window.clearTimeout(timeout);
  }, [file, pageNumber, pdf, token]);

  if (!file) {
    return (
      <section className="reader-placeholder">
        <p className="eyebrow">Reader</p>
        <h2>Select a PDF</h2>
        <p>Upload a PDF, then select it from the library to render pages here.</p>
      </section>
    );
  }

  return (
    <section className="reader-placeholder reader-active">
      <div className="reader-bar">
        <div>
          <p className="eyebrow">Reader</p>
          <h2>{file.name}</h2>
          <p className="sync-line">Progress: {syncStatus === "idle" ? "ready" : syncStatus}</p>
        </div>
        {pdf ? (
          <div className="page-controls">
            <button className="secondary" onClick={() => setPageNumber((page) => Math.max(1, page - 1))} disabled={pageNumber <= 1}>Previous</button>
            <span>{pageNumber} / {pdf.numPages}</span>
            <button className="secondary" onClick={() => setPageNumber((page) => Math.min(pdf.numPages, page + 1))} disabled={pageNumber >= pdf.numPages}>Next</button>
          </div>
        ) : null}
      </div>

      {isLoading ? <p>Loading PDF...</p> : null}
      {error ? <p className="error">{error}</p> : null}
      <div className="canvas-stage">
        <canvas ref={canvasRef} />
      </div>
    </section>
  );
}
