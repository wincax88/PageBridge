import { useEffect, useRef, useState, type MouseEvent } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import {
  createHighlightAnnotation,
  createTextNoteAnnotation,
  deleteAnnotation,
  downloadPdf,
  getReadingProgress,
  listAnnotations,
  saveReadingProgress,
  updateFilePageCount,
  updateAnnotationNote,
  type AnnotationRecord,
  type FileRecord
} from "../lib/api";
import { offlineDb } from "../lib/offline-db";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

interface PdfReaderProps {
  token: string;
  file: FileRecord | null;
  syncPulse: number;
}

interface SearchResult {
  page: number;
  preview: string;
}

interface OutlineItem {
  id: string;
  title: string;
  dest: string | unknown[] | null;
  level: number;
}

interface PendingNotePayload {
  fileId: string;
  input: {
    page: number;
    note: string;
    rect: { x: number; y: number; width: number; height: number };
    pageWidth: number;
    pageHeight: number;
  };
}

export default function PdfReader({ token, file, syncPulse }: PdfReaderProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pageLayerRef = useRef<HTMLDivElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null);
  const restoredFileIdRef = useRef<string | null>(null);
  const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [scale, setScale] = useState(1.35);
  const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "synced" | "failed">("idle");
  const [annotationStatus, setAnnotationStatus] = useState<"idle" | "saving" | "queued" | "failed">("idle");
  const [annotations, setAnnotations] = useState<AnnotationRecord[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [editingNote, setEditingNote] = useState("");
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchStatus, setSearchStatus] = useState<"idle" | "searching" | "done" | "failed">("idle");
  const [outlineItems, setOutlineItems] = useState<OutlineItem[]>([]);
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
      setOutlineItems([]);
      restoredFileIdRef.current = null;

      try {
        const data = await downloadPdf(token, file.id);
        const document = await pdfjs.getDocument({ data }).promise;
        if (!cancelled) {
          setPdf(document);
          void loadOutline(document);
          if (file.pageCount !== document.numPages) {
            void updateFilePageCount(token, file.id, document.numPages).catch(() => undefined);
          }
        }
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

  async function loadOutline(document: pdfjs.PDFDocumentProxy) {
    try {
      const outline = await document.getOutline();
      setOutlineItems(flattenOutline(outline ?? []));
    } catch {
      setOutlineItems([]);
    }
  }

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
  }, [file, syncPulse, token]);

  useEffect(() => {
    if (!file) return;

    const replay = () => void replayPendingNotes();
    void replayPendingNotes();
    window.addEventListener("online", replay);
    return () => window.removeEventListener("online", replay);
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
        await renderTextLayer(page, viewport);
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

  async function renderTextLayer(page: pdfjs.PDFPageProxy, viewport: pdfjs.PageViewport) {
    const layer = textLayerRef.current;
    if (!layer) return;

    const textContent = await page.getTextContent();
    layer.replaceChildren();
    layer.style.width = `${viewport.width}px`;
    layer.style.height = `${viewport.height}px`;

    for (const item of textContent.items) {
      if (!("str" in item) || !item.str.trim()) continue;

      const span = document.createElement("span");
      const transform = pdfjs.Util.transform(viewport.transform, item.transform);
      const fontHeight = Math.hypot(transform[2], transform[3]);
      span.textContent = item.str;
      span.style.left = `${transform[4]}px`;
      span.style.top = `${transform[5] - fontHeight}px`;
      span.style.fontSize = `${fontHeight}px`;
      span.style.transform = `scaleX(${item.width ? Math.max(0.1, (item.width * scale) / span.textContent.length / Math.max(fontHeight * 0.45, 1)) : 1})`;
      layer.append(span);
    }
  }

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

    const input = {
      page: pageNumber,
      note: note.trim(),
      rect: { x, y, width: 18, height: 18 },
      pageWidth: pageSize.width,
      pageHeight: pageSize.height
    };

    if (!navigator.onLine) {
      await queuePendingNote(file.id, input);
      return;
    }

    setAnnotationStatus("saving");
    try {
      const created = await createTextNoteAnnotation(token, file.id, input);
      setAnnotations((current) => [...current, created]);
      setSelectedAnnotationId(created.id);
      setAnnotationStatus("idle");
    } catch (err) {
      setAnnotationStatus("failed");
      setError(err instanceof Error ? err.message : "Failed to save annotation");
    }
  }

  async function queuePendingNote(fileId: string, input: PendingNotePayload["input"]) {
    const localId = `offline-${crypto.randomUUID()}`;
    await offlineDb.pendingChanges.add({
      entityType: "annotation",
      entityId: localId,
      operation: "create",
      payload: { fileId, input } satisfies PendingNotePayload,
      createdAt: new Date().toISOString()
    });

    const now = new Date().toISOString();
    setAnnotations((current) => [
      ...current,
      {
        id: localId,
        fileId,
        type: "text_note",
        page: input.page,
        color: "#C96E3A",
        text: null,
        note: input.note,
        quadPoints: null,
        rect: input.rect,
        pageWidth: input.pageWidth,
        pageHeight: input.pageHeight,
        version: 1,
        updatedAt: now
      }
    ]);
    setSelectedAnnotationId(localId);
    setAnnotationStatus("queued");
  }

  async function replayPendingNotes() {
    if (!navigator.onLine) return;

    const pendingChanges = await offlineDb.pendingChanges.toArray();
    const pendingNotes = pendingChanges.filter((change) => change.entityType === "annotation" && change.operation === "create");
    if (!pendingNotes.length) return;

    setAnnotationStatus("saving");
    let replayedCurrentFile = false;
    try {
      for (const change of pendingNotes) {
        const payload = change.payload as PendingNotePayload;
        await createTextNoteAnnotation(token, payload.fileId, payload.input);
        if (change.id !== undefined) await offlineDb.pendingChanges.delete(change.id);
        if (payload.fileId === file?.id) replayedCurrentFile = true;
      }
      if (replayedCurrentFile && file) {
        setAnnotations(await listAnnotations(token, file.id));
      }
      setAnnotationStatus("idle");
    } catch {
      setAnnotationStatus("queued");
    }
  }

  async function handleCreateHighlight() {
    if (!file || !pageSize.width || !pageSize.height || !pageLayerRef.current) return;

    const selection = window.getSelection();
    const selectedText = selection?.toString().trim();
    if (!selection || !selectedText || selection.rangeCount === 0) return;

    const pageBounds = pageLayerRef.current.getBoundingClientRect();
    const rects = Array.from(selection.getRangeAt(0).getClientRects())
      .map((rect) => ({
        x: Math.max(0, rect.left - pageBounds.left),
        y: Math.max(0, rect.top - pageBounds.top),
        width: Math.min(rect.width, pageBounds.right - rect.left),
        height: Math.min(rect.height, pageBounds.bottom - rect.top)
      }))
      .filter((rect) => rect.width > 1 && rect.height > 1 && rect.x <= pageSize.width && rect.y <= pageSize.height);

    if (rects.length === 0) return;

    setAnnotationStatus("saving");
    try {
      const created = await createHighlightAnnotation(token, file.id, {
        page: pageNumber,
        text: selectedText,
        quadPoints: rects,
        pageWidth: pageSize.width,
        pageHeight: pageSize.height
      });
      setAnnotations((current) => [...current, created]);
      setSelectedAnnotationId(created.id);
      setAnnotationStatus("idle");
      selection.removeAllRanges();
    } catch (err) {
      setAnnotationStatus("failed");
      setError(err instanceof Error ? err.message : "Failed to save highlight");
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

  useEffect(() => {
    if (!pdf) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";

      if (event.key === "/" && !isTyping) {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if (isTyping) return;

      if (event.key === "ArrowLeft") {
        setPageNumber((page) => Math.max(1, page - 1));
      } else if (event.key === "ArrowRight") {
        setPageNumber((page) => Math.min(pdf.numPages, page + 1));
      } else if ((event.ctrlKey || event.metaKey) && (event.key === "+" || event.key === "=")) {
        event.preventDefault();
        changeScale(0.15);
      } else if ((event.ctrlKey || event.metaKey) && event.key === "-") {
        event.preventDefault();
        changeScale(-0.15);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pdf]);

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

  async function jumpToOutlineItem(item: OutlineItem) {
    if (!pdf || !item.dest) return;

    try {
      const destination = typeof item.dest === "string" ? await pdf.getDestination(item.dest) : item.dest;
      const pageRef = destination?.[0];
      if (!pageRef) return;
      const pageIndex = await pdf.getPageIndex(pageRef as Parameters<typeof pdf.getPageIndex>[0]);
      setPageNumber(pageIndex + 1);
    } catch {
      setError("Failed to open outline destination");
    }
  }

  const visibleAnnotations = annotations.filter((annotation) => annotation.page === pageNumber && annotation.rect);
  const visibleHighlights = annotations.filter((annotation) => annotation.page === pageNumber && annotation.quadPoints);
  const selectedAnnotation = annotations.find((annotation) => annotation.id === selectedAnnotationId) ?? null;
  const visibleNotes = visibleAnnotations.filter((annotation) => annotation.type === "text_note");

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
          <p className="sync-line">Annotations: {annotationStatus === "idle" ? visibleNotes.length + visibleHighlights.length : annotationStatus}</p>
          <p className="shortcut-line"><kbd>←</kbd>/<kbd>→</kbd> pages · <kbd>/</kbd> search · <kbd>Ctrl</kbd> + <kbd>+/-</kbd> zoom</p>
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
            ref={searchInputRef}
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
      {outlineItems.length ? (
        <div className="outline-panel">
          <p className="eyebrow">Contents</p>
          <div className="outline-list">
            {outlineItems.slice(0, 80).map((item) => (
              <button className="outline-item" key={item.id} onClick={() => void jumpToOutlineItem(item)} style={{ paddingLeft: `${0.75 + item.level * 1.1}rem` }}>
                {item.title}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="canvas-stage">
        <div ref={pageLayerRef} className="page-layer" onDoubleClick={handleCreateNote} style={{ width: pageSize.width || undefined, height: pageSize.height || undefined }}>
          <canvas ref={canvasRef} />
          <div ref={textLayerRef} className="text-layer" onMouseUp={() => void handleCreateHighlight()} />
          {pageSize.width && pageSize.height ? (
            <svg className="annotation-layer" viewBox={`0 0 ${pageSize.width} ${pageSize.height}`} aria-label="Page annotations">
              {visibleHighlights.map((annotation) => {
                const scaleX = annotation.pageWidth ? pageSize.width / annotation.pageWidth : 1;
                const scaleY = annotation.pageHeight ? pageSize.height / annotation.pageHeight : 1;

                return annotation.quadPoints!.map((rect, index) => (
                  <rect
                    className={selectedAnnotationId === annotation.id ? "highlight-rect selected" : "highlight-rect"}
                    key={`${annotation.id}-${index}`}
                    x={rect.x * scaleX}
                    y={rect.y * scaleY}
                    width={rect.width * scaleX}
                    height={rect.height * scaleY}
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedAnnotationId(annotation.id);
                    }}
                  />
                ));
              })}
              {visibleNotes.map((annotation) => {
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
          <h3>{visibleNotes.length + visibleHighlights.length ? `${visibleNotes.length + visibleHighlights.length} on this page` : "No annotations yet"}</h3>
          <p className="helper-text">Select text to highlight it. Double-click the page to add a note.</p>
        </div>

        {selectedAnnotation?.type === "text_note" ? (
          <article className="selected-note">
            <strong>Selected note</strong>
            <textarea value={editingNote} onChange={(event) => setEditingNote(event.target.value)} rows={4} />
            <div className="note-actions">
              <button onClick={handleSaveSelectedNote} disabled={annotationStatus === "saving" || !editingNote.trim()}>Save note</button>
              <button className="secondary danger" onClick={() => handleDeleteAnnotation(selectedAnnotation.id)} disabled={annotationStatus === "saving"}>Delete note</button>
            </div>
          </article>
        ) : null}
        {selectedAnnotation?.type === "highlight" ? (
          <article className="selected-note highlight-note">
            <strong>Selected highlight</strong>
            <p>{selectedAnnotation.text}</p>
            <button className="secondary danger" onClick={() => handleDeleteAnnotation(selectedAnnotation.id)} disabled={annotationStatus === "saving"}>Delete highlight</button>
          </article>
        ) : null}

        <div className="note-list">
          {[...visibleHighlights, ...visibleNotes].map((annotation, index) => (
            <button
              className={selectedAnnotationId === annotation.id ? "note-item selected" : "note-item"}
              key={annotation.id}
              onClick={() => setSelectedAnnotationId(annotation.id)}
            >
              <span>{annotation.type === "highlight" ? "Highlight" : "Note"} {index + 1}</span>
              <small>{annotation.text ?? annotation.note}</small>
            </button>
          ))}
        </div>
      </aside>
    </section>
  );
}

function flattenOutline(items: unknown[], level = 0, prefix = ""): OutlineItem[] {
  return items.flatMap((rawItem, index) => {
    const item = rawItem as { title?: string; dest?: string | unknown[] | null; items?: unknown[] };
    const id = `${prefix}${index}`;
    const current = item.title ? [{ id, title: item.title, dest: item.dest ?? null, level }] : [];
    return [...current, ...flattenOutline(item.items ?? [], level + 1, `${id}-`)];
  });
}
