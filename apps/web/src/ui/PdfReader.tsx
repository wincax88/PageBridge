import { useEffect, useRef, useState, type MouseEvent } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import {
  createTextNoteAnnotation,
  downloadPdf,
  getReadingProgress,
  listAnnotations,
  saveReadingProgress,
  type AnnotationRecord,
  type FileRecord
} from "../lib/api";

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
  const [annotationStatus, setAnnotationStatus] = useState<"idle" | "saving" | "failed">("idle");
  const [annotations, setAnnotations] = useState<AnnotationRecord[]>([]);
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadPdf() {
      if (!file) return;
      setIsLoading(true);
      setError(null);
      setPdf(null);
      setAnnotations([]);
      setPageSize({ width: 0, height: 0 });
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

    async function loadAnnotations() {
      if (!file) return;

      try {
        const records = await listAnnotations(token, file.id);
        if (!cancelled) setAnnotations(records);
      } catch {
        if (!cancelled) setAnnotationStatus("failed");
      }
    }

    void loadAnnotations();
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
      setPageSize({ width: viewport.width, height: viewport.height });

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

  async function handleCreateNote(event: MouseEvent<HTMLDivElement>) {
    if (!file || !pageSize.width || !pageSize.height) return;

    const target = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - target.left;
    const y = event.clientY - target.top;
    const note = window.prompt("Add a note for this page position");
    if (!note?.trim()) return;

    setAnnotationStatus("saving");
    try {
      const created = await createTextNoteAnnotation(token, file.id, {
        page: pageNumber,
        note: note.trim(),
        rect: { x, y, width: 18, height: 18 },
        pageWidth: pageSize.width,
        pageHeight: pageSize.height
      });
      setAnnotations((current) => [...current, created]);
      setAnnotationStatus("idle");
    } catch (err) {
      setAnnotationStatus("failed");
      setError(err instanceof Error ? err.message : "Failed to save annotation");
    }
  }

  const visibleAnnotations = annotations.filter((annotation) => annotation.page === pageNumber && annotation.rect);

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
          <p className="sync-line">Notes: {annotationStatus === "idle" ? visibleAnnotations.length : annotationStatus}</p>
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
        <div className="page-layer" onDoubleClick={handleCreateNote} style={{ width: pageSize.width || undefined, height: pageSize.height || undefined }}>
          <canvas ref={canvasRef} />
          {pageSize.width && pageSize.height ? (
            <svg className="annotation-layer" viewBox={`0 0 ${pageSize.width} ${pageSize.height}`} aria-label="Page annotations">
              {visibleAnnotations.map((annotation) => {
                const rect = annotation.rect!;
                const scaleX = annotation.pageWidth ? pageSize.width / annotation.pageWidth : 1;
                const scaleY = annotation.pageHeight ? pageSize.height / annotation.pageHeight : 1;
                const x = rect.x * scaleX;
                const y = rect.y * scaleY;

                return (
                  <g key={annotation.id} className="annotation-marker">
                    <circle cx={x} cy={y} r="9" />
                    <title>{annotation.note ?? "Note"}</title>
                  </g>
                );
              })}
            </svg>
          ) : null}
        </div>
      </div>
    </section>
  );
}
