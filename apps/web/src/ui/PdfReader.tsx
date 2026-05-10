import { useEffect, useRef, useState, type MouseEvent } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import {
  createTextNoteAnnotation,
  deleteAnnotation,
  downloadPdf,
  getReadingProgress,
  listAnnotations,
  saveReadingProgress,
  updateAnnotationNote,
  type AnnotationRecord,
  type FileRecord
} from "../lib/api";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

interface PdfReaderProps {
  token: string;
  file: FileRecord | null;
}

interface SearchResult {
  page: number;
  preview: string;
}

export function PdfReader({ token, file }: PdfReaderProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null);
  const restoredFileIdRef = useRef<string | null>(null);
  const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [scale, setScale] = useState(1.35);
  const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "synced" | "failed">("idle");
  const [annotationStatus, setAnnotationStatus] = useState<"idle" | "saving" | "failed">("idle");
  const [annotations, setAnnotations] = useState<AnnotationRecord[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [editingNote, setEditingNote] = useState("");
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchStatus, setSearchStatus] = useState<"idle" | "searching" | "done" | "failed">("idle");
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
      setSelectedAnnotationId(null);
      setEditingNote("");
      setPageSize({ width: 0, height: 0 });
      setPageNumber(1);
      setPageInput("1");
      setScale(1.35);
      setSearchQuery("");
      setSearchResults([]);
      setSearchStatus("idle");
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
          if (progress.zoomValue) {
            setScale(Number(Math.min(2.5, Math.max(0.75, progress.zoomValue)).toFixed(2)));
          }
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
      const viewport = page.getViewport({ scale });
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
  }, [pageNumber, pdf, scale]);

  useEffect(() => {
    setPageInput(String(pageNumber));
  }, [pageNumber]);

  useEffect(() => {
    if (!file || !pdf || restoredFileIdRef.current !== file.id) return;

    const timeout = window.setTimeout(() => {
      setSyncStatus("syncing");
      saveReadingProgress(token, file.id, pageNumber, scale)
        .then(() => setSyncStatus("synced"))
        .catch(() => setSyncStatus("failed"));
    }, 350);

    return () => window.clearTimeout(timeout);
  }, [file, pageNumber, pdf, scale, token]);

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
      setSelectedAnnotationId(created.id);
      setAnnotationStatus("idle");
    } catch (err) {
      setAnnotationStatus("failed");
      setError(err instanceof Error ? err.message : "Failed to save annotation");
    }
  }

  async function handleDeleteAnnotation(annotationId: string) {
    if (!file) return;

    setAnnotationStatus("saving");
    try {
      await deleteAnnotation(token, file.id, annotationId);
      setAnnotations((current) => current.filter((annotation) => annotation.id !== annotationId));
      setSelectedAnnotationId((current) => (current === annotationId ? null : current));
      setAnnotationStatus("idle");
    } catch (err) {
      setAnnotationStatus("failed");
      setError(err instanceof Error ? err.message : "Failed to delete annotation");
    }
  }

  async function handleSaveSelectedNote() {
    if (!file || !selectedAnnotation) return;

    const note = editingNote.trim();
    if (!note) return;

    setAnnotationStatus("saving");
    try {
      const updated = await updateAnnotationNote(token, file.id, selectedAnnotation.id, note);
      setAnnotations((current) => current.map((annotation) => (annotation.id === updated.id ? updated : annotation)));
      setAnnotationStatus("idle");
    } catch (err) {
      setAnnotationStatus("failed");
      setError(err instanceof Error ? err.message : "Failed to update annotation");
    }
  }

  function jumpToPage() {
    if (!pdf) return;

    const nextPage = Number.parseInt(pageInput, 10);
    if (!Number.isFinite(nextPage)) {
      setPageInput(String(pageNumber));
      return;
    }

    setPageNumber(Math.min(Math.max(1, nextPage), pdf.numPages));
  }

  function changeScale(delta: number) {
    setScale((current) => Number(Math.min(2.5, Math.max(0.75, current + delta)).toFixed(2)));
  }

  async function searchDocument() {
    if (!pdf) return;

    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      setSearchResults([]);
      setSearchStatus("idle");
      return;
    }

    setSearchStatus("searching");
    setSearchResults([]);

    try {
      const results: SearchResult[] = [];
      for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex += 1) {
        const page = await pdf.getPage(pageIndex);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map((item) => ("str" in item ? item.str : "")).join(" ");
        const matchIndex = pageText.toLowerCase().indexOf(query);
        if (matchIndex >= 0) {
          const start = Math.max(0, matchIndex - 48);
          const end = Math.min(pageText.length, matchIndex + query.length + 72);
          results.push({ page: pageIndex, preview: pageText.slice(start, end).trim() });
        }
      }

      setSearchResults(results);
      setSearchStatus("done");
      if (results[0]) setPageNumber(results[0].page);
    } catch (err) {
      setSearchStatus("failed");
      setError(err instanceof Error ? err.message : "Failed to search PDF text");
    }
  }

  const visibleAnnotations = annotations.filter((annotation) => annotation.page === pageNumber && annotation.rect);
  const selectedAnnotation = visibleAnnotations.find((annotation) => annotation.id === selectedAnnotationId) ?? null;

  useEffect(() => {
    setEditingNote(selectedAnnotation?.note ?? "");
  }, [selectedAnnotation?.id, selectedAnnotation?.note]);

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
            <form
              className="page-jump"
              onSubmit={(event) => {
                event.preventDefault();
                jumpToPage();
              }}
            >
              <input
                aria-label="Page number"
                inputMode="numeric"
                value={pageInput}
                onBlur={jumpToPage}
                onChange={(event) => setPageInput(event.target.value)}
              />
              <span>/ {pdf.numPages}</span>
            </form>
            <button className="secondary" onClick={() => setPageNumber((page) => Math.min(pdf.numPages, page + 1))} disabled={pageNumber >= pdf.numPages}>Next</button>
            <div className="zoom-controls">
              <button className="secondary" onClick={() => changeScale(-0.15)} disabled={scale <= 0.75}>-</button>
              <span>{Math.round(scale * 100)}%</span>
              <button className="secondary" onClick={() => changeScale(0.15)} disabled={scale >= 2.5}>+</button>
            </div>
          </div>
        ) : null}
      </div>

      {isLoading ? <p>Loading PDF...</p> : null}
      {error ? <p className="error">{error}</p> : null}
      {pdf ? (
        <form
          className="search-bar"
          onSubmit={(event) => {
            event.preventDefault();
            void searchDocument();
          }}
        >
          <input
            aria-label="Search PDF text"
            placeholder="Search text in this PDF"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          <button disabled={searchStatus === "searching"}>{searchStatus === "searching" ? "Searching" : "Search"}</button>
        </form>
      ) : null}
      {searchStatus === "done" ? (
        <div className="search-results">
          <p>{searchResults.length ? `${searchResults.length} pages matched` : "No text matches found"}</p>
          {searchResults.slice(0, 8).map((result) => (
            <button className="search-result" key={`${result.page}-${result.preview}`} onClick={() => setPageNumber(result.page)}>
              <strong>Page {result.page}</strong>
              <span>{result.preview}</span>
            </button>
          ))}
        </div>
      ) : null}
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
                  <g
                    key={annotation.id}
                    className={selectedAnnotationId === annotation.id ? "annotation-marker selected" : "annotation-marker"}
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedAnnotationId(annotation.id);
                    }}
                  >
                    <circle cx={x} cy={y} r="9" />
                    <title>{annotation.note ?? "Note"}</title>
                  </g>
                );
              })}
            </svg>
          ) : null}
        </div>
      </div>
      <aside className="annotation-panel">
        <div>
          <p className="eyebrow">Page notes</p>
          <h3>{visibleAnnotations.length ? `${visibleAnnotations.length} on this page` : "No notes yet"}</h3>
          <p className="helper-text">Double-click the page to add a note.</p>
        </div>

        {selectedAnnotation ? (
          <article className="selected-note">
            <strong>Selected note</strong>
            <textarea value={editingNote} onChange={(event) => setEditingNote(event.target.value)} rows={4} />
            <div className="note-actions">
              <button onClick={handleSaveSelectedNote} disabled={annotationStatus === "saving" || !editingNote.trim()}>Save note</button>
              <button className="secondary danger" onClick={() => handleDeleteAnnotation(selectedAnnotation.id)} disabled={annotationStatus === "saving"}>Delete note</button>
            </div>
          </article>
        ) : null}

        <div className="note-list">
          {visibleAnnotations.map((annotation, index) => (
            <button
              className={selectedAnnotationId === annotation.id ? "note-item selected" : "note-item"}
              key={annotation.id}
              onClick={() => setSelectedAnnotationId(annotation.id)}
            >
              <span>Note {index + 1}</span>
              <small>{annotation.note}</small>
            </button>
          ))}
        </div>
      </aside>
    </section>
  );
}
