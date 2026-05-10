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
  updateAnnotation,
  ApiError,
  type AnnotationRecord,
  type FileRecord
} from "../lib/api";
import { offlineDb } from "../lib/offline-db";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const ANNOTATION_COLORS = ["#FFE066", "#F1C46B", "#C96E3A", "#8BCB88", "#7FB3D5", "#CBA6F7"];
type ZoomMode = "custom" | "fit_width" | "fit_page";

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
    rect: AnnotationRect;
    pageWidth: number;
    pageHeight: number;
  };
}

type AnnotationRect = { x: number; y: number; width: number; height: number; coordinateSpace?: "pdf" | "viewport" };

interface PendingHighlightPayload {
  fileId: string;
  input: {
    page: number;
    text: string;
    quadPoints: AnnotationRect[];
    pageWidth: number;
    pageHeight: number;
  };
}

interface PendingAnnotationUpdatePayload {
  fileId: string;
  annotationId: string;
  input: { note?: string; color?: string; baseVersion?: number };
}

interface PendingAnnotationDeletePayload {
  fileId: string;
  annotationId: string;
}

interface DeletedAnnotationSnapshot {
  annotation: AnnotationRecord;
  expiresAt: number;
}

export default function PdfReader({ token, file, syncPulse }: PdfReaderProps) {
  const readerRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasStageRef = useRef<HTMLDivElement | null>(null);
  const pageLayerRef = useRef<HTMLDivElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null);
  const viewportRef = useRef<pdfjs.PageViewport | null>(null);
  const pendingScrollOffsetRef = useRef<number | null>(null);
  const restoredFileIdRef = useRef<string | null>(null);
  const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [scale, setScale] = useState(1.35);
  const [zoomMode, setZoomMode] = useState<ZoomMode>("custom");
  const [scrollOffset, setScrollOffset] = useState(0);
  const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "synced" | "failed">("idle");
  const [annotationStatus, setAnnotationStatus] = useState<"idle" | "saving" | "queued" | "failed" | "conflict">("idle");
  const [annotations, setAnnotations] = useState<AnnotationRecord[]>([]);
  const [deletedAnnotation, setDeletedAnnotation] = useState<DeletedAnnotationSnapshot | null>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [editingNote, setEditingNote] = useState("");
  const [editingColor, setEditingColor] = useState(ANNOTATION_COLORS[0]);
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
      setZoomMode("custom");
      setScrollOffset(0);
      pendingScrollOffsetRef.current = null;
      setSearchQuery("");
      setSearchResults([]);
      setSearchStatus("idle");
      setOutlineItems([]);
      restoredFileIdRef.current = null;

      try {
        const data = await loadPdfData(file.id);
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

  async function loadPdfData(fileId: string) {
    try {
      const data = await downloadPdf(token, fileId);
      await offlineDb.pdfFiles.put({ fileId, data: data.slice(0), updatedAt: new Date().toISOString() });
      return data;
    } catch (err) {
      const cached = await offlineDb.pdfFiles.get(fileId);
      if (cached) return cached.data.slice(0);
      throw err;
    }
  }

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
        await cacheAnnotations(file.id, records);
        if (!cancelled) setAnnotations(records);
      } catch {
        const cached = await offlineDb.annotationLists.get(file.id);
        if (!cancelled && cached) {
          setAnnotations(cached.annotations as AnnotationRecord[]);
          setAnnotationStatus("queued");
          return;
        }
        if (!cancelled) setAnnotationStatus("failed");
      }
    }

    void loadAnnotations();
    return () => {
      cancelled = true;
    };
  }, [file, syncPulse, token]);

  async function cacheAnnotations(fileId: string, records: AnnotationRecord[]) {
    await offlineDb.annotationLists.put({ fileId, annotations: records, updatedAt: new Date().toISOString() });
  }

  function updateAnnotations(updater: (current: AnnotationRecord[]) => AnnotationRecord[]) {
    setAnnotations((current) => {
      const next = updater(current);
      if (file) void cacheAnnotations(file.id, next);
      return next;
    });
  }

  useEffect(() => {
    if (!file) return;

    const replay = () => void replayPendingAnnotationChanges();
    void replayPendingAnnotationChanges();
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
          if (progress.zoomMode === "fit_width" || progress.zoomMode === "fit_page") {
            setZoomMode(progress.zoomMode);
          }
          pendingScrollOffsetRef.current = progress.scrollOffset;
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
      viewportRef.current = viewport;
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
        restorePendingScrollOffset();
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

  function restorePendingScrollOffset() {
    const offset = pendingScrollOffsetRef.current;
    const reader = readerRef.current;
    if (offset === null || !reader) return;

    window.requestAnimationFrame(() => {
      reader.scrollTop = offset;
      setScrollOffset(offset);
      pendingScrollOffsetRef.current = null;
    });
  }

  useEffect(() => {
    setPageInput(String(pageNumber));
  }, [pageNumber]);

  useEffect(() => {
    if (!file || !pdf || restoredFileIdRef.current !== file.id) return;

    const timeout = window.setTimeout(() => {
      setSyncStatus("syncing");
      saveReadingProgress(token, file.id, pageNumber, scale, zoomMode, scrollOffset)
        .then(() => setSyncStatus("synced"))
        .catch(() => setSyncStatus("failed"));
    }, 350);

    return () => window.clearTimeout(timeout);
  }, [file, pageNumber, pdf, scale, token, zoomMode, scrollOffset]);

  useEffect(() => {
    if (!pdf || zoomMode === "custom") return;

    let cancelled = false;
    const fit = () => {
      void applyFitZoom(zoomMode, cancelled);
    };

    fit();
    window.addEventListener("resize", fit);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", fit);
    };
  }, [pageNumber, pdf, zoomMode]);

  async function handleCreateNote(event: MouseEvent<HTMLDivElement>) {
    if (!file || !pageSize.width || !pageSize.height || !viewportRef.current) return;

    const target = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - target.left;
    const y = event.clientY - target.top;
    const note = window.prompt("Add a note for this page position");
    if (!note?.trim()) return;

    const input = {
      page: pageNumber,
      note: note.trim(),
      rect: viewportRectToPdfRect({ x, y, width: 18, height: 18 }, viewportRef.current),
      pageWidth: pageSize.width / scale,
      pageHeight: pageSize.height / scale
    };

    if (!navigator.onLine) {
      await queuePendingAnnotationCreate(`offline-${crypto.randomUUID()}`, file.id, "text_note", input);
      return;
    }

    setAnnotationStatus("saving");
    try {
      const created = await createTextNoteAnnotation(token, file.id, input);
      updateAnnotations((current) => [...current, created]);
      setSelectedAnnotationId(created.id);
      setAnnotationStatus("idle");
    } catch (err) {
      setAnnotationStatus("failed");
      setError(err instanceof Error ? err.message : "Failed to save annotation");
    }
  }

  async function queuePendingAnnotationCreate(
    localId: string,
    fileId: string,
    type: "text_note" | "highlight",
    input: PendingNotePayload["input"] | PendingHighlightPayload["input"]
  ) {
    await offlineDb.pendingChanges.add({
      entityType: "annotation",
      entityId: localId,
      operation: "create",
      payload: { fileId, type, input },
      createdAt: new Date().toISOString()
    });

    const now = new Date().toISOString();
    const isHighlight = type === "highlight";
    updateAnnotations((current) => [
      ...current,
      {
        id: localId,
        fileId,
        type,
        page: input.page,
        color: isHighlight ? "#FFE066" : "#C96E3A",
        text: isHighlight ? (input as PendingHighlightPayload["input"]).text : null,
        note: isHighlight ? null : (input as PendingNotePayload["input"]).note,
        quadPoints: isHighlight ? (input as PendingHighlightPayload["input"]).quadPoints : null,
        rect: isHighlight ? null : (input as PendingNotePayload["input"]).rect,
        pageWidth: input.pageWidth,
        pageHeight: input.pageHeight,
        version: 1,
        updatedAt: now
      }
    ]);
    setSelectedAnnotationId(localId);
    setAnnotationStatus("queued");
  }

  async function queuePendingAnnotationUpdate(annotationId: string, input: PendingAnnotationUpdatePayload["input"]) {
    if (!file) return;

    await offlineDb.pendingChanges.add({
      entityType: "annotation",
      entityId: annotationId,
      operation: "update",
      payload: { fileId: file.id, annotationId, input } satisfies PendingAnnotationUpdatePayload,
      createdAt: new Date().toISOString()
    });
    const { baseVersion: _baseVersion, ...optimisticInput } = input;
    updateAnnotations((current) => current.map((annotation) => (annotation.id === annotationId ? { ...annotation, ...optimisticInput, updatedAt: new Date().toISOString() } : annotation)));
    setAnnotationStatus("queued");
  }

  async function queuePendingAnnotationDelete(annotationId: string) {
    if (!file) return;

    if (annotationId.startsWith("offline-")) {
      await offlineDb.pendingChanges.where("entityId").equals(annotationId).delete();
    } else {
      await offlineDb.pendingChanges.add({
        entityType: "annotation",
        entityId: annotationId,
        operation: "delete",
        payload: { fileId: file.id, annotationId } satisfies PendingAnnotationDeletePayload,
        createdAt: new Date().toISOString()
      });
    }
    updateAnnotations((current) => current.filter((annotation) => annotation.id !== annotationId));
    setSelectedAnnotationId((current) => (current === annotationId ? null : current));
    setAnnotationStatus("queued");
  }

  async function replayPendingAnnotationChanges() {
    if (!navigator.onLine) return;

    const pendingChanges = await offlineDb.pendingChanges.toArray();
    const pendingAnnotations = pendingChanges.filter((change) => change.entityType === "annotation").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (!pendingAnnotations.length) return;

    setAnnotationStatus("saving");
    let replayedCurrentFile = false;
    try {
      for (const change of pendingAnnotations) {
        if (change.operation === "create") {
          const payload = change.payload as (PendingNotePayload & { type?: "text_note" }) | (PendingHighlightPayload & { type: "highlight" });
          if (payload.type === "highlight") {
            await createHighlightAnnotation(token, payload.fileId, payload.input as PendingHighlightPayload["input"]);
          } else {
            await createTextNoteAnnotation(token, payload.fileId, payload.input as PendingNotePayload["input"]);
          }
          if (payload.fileId === file?.id) replayedCurrentFile = true;
        } else if (change.operation === "update") {
          const payload = change.payload as PendingAnnotationUpdatePayload;
          await updateAnnotation(token, payload.fileId, payload.annotationId, payload.input);
          if (payload.fileId === file?.id) replayedCurrentFile = true;
        } else if (change.operation === "delete") {
          const payload = change.payload as PendingAnnotationDeletePayload;
          await deleteAnnotation(token, payload.fileId, payload.annotationId);
          if (payload.fileId === file?.id) replayedCurrentFile = true;
        }
        if (change.id !== undefined) await offlineDb.pendingChanges.delete(change.id);
      }
      if (replayedCurrentFile && file) {
        const records = await listAnnotations(token, file.id);
        await cacheAnnotations(file.id, records);
        setAnnotations(records);
      }
      setAnnotationStatus("idle");
    } catch (err) {
      await handleAnnotationError(err, "Failed to sync annotation changes");
    }
  }

  async function handleCreateHighlight() {
    if (!file || !pageSize.width || !pageSize.height || !pageLayerRef.current || !viewportRef.current) return;

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
    const quadPoints = rects.map((rect) => viewportRectToPdfRect(rect, viewportRef.current!));
    const basePageWidth = pageSize.width / scale;
    const basePageHeight = pageSize.height / scale;

    if (!navigator.onLine) {
      await queuePendingAnnotationCreate(`offline-${crypto.randomUUID()}`, file.id, "highlight", {
        page: pageNumber,
        text: selectedText,
        quadPoints,
        pageWidth: basePageWidth,
        pageHeight: basePageHeight
      });
      selection.removeAllRanges();
      return;
    }

    setAnnotationStatus("saving");
    try {
      const created = await createHighlightAnnotation(token, file.id, {
        page: pageNumber,
        text: selectedText,
        quadPoints,
        pageWidth: basePageWidth,
        pageHeight: basePageHeight
      });
      updateAnnotations((current) => [...current, created]);
      setSelectedAnnotationId(created.id);
      setAnnotationStatus("idle");
      selection.removeAllRanges();
    } catch (err) {
      await handleAnnotationError(err, "Failed to save highlight");
    }
  }

  async function handleDeleteAnnotation(annotationId: string) {
    if (!file) return;
    const annotation = annotations.find((item) => item.id === annotationId);
    if (!annotation) return;

    if (!navigator.onLine) {
      await queuePendingAnnotationDelete(annotationId);
      setDeletedAnnotation({ annotation, expiresAt: Date.now() + 8000 });
      return;
    }

    setAnnotationStatus("saving");
    try {
      await deleteAnnotation(token, file.id, annotationId);
      updateAnnotations((current) => current.filter((item) => item.id !== annotationId));
      setSelectedAnnotationId((current) => (current === annotationId ? null : current));
      setDeletedAnnotation({ annotation, expiresAt: Date.now() + 8000 });
      setAnnotationStatus("idle");
    } catch (err) {
      await handleAnnotationError(err, "Failed to delete annotation");
    }
  }

  async function handleUndoDelete() {
    if (!file || !deletedAnnotation || Date.now() > deletedAnnotation.expiresAt) {
      setDeletedAnnotation(null);
      return;
    }

    const annotation = deletedAnnotation.annotation;
    setDeletedAnnotation(null);

    if (annotation.id.startsWith("offline-")) {
      await offlineDb.pendingChanges.where("entityId").equals(annotation.id).delete();
      updateAnnotations((current) => [...current, annotation]);
      setSelectedAnnotationId(annotation.id);
      setAnnotationStatus("queued");
      return;
    }

    setAnnotationStatus("saving");
    try {
      const restored = annotation.type === "highlight" && annotation.quadPoints
        ? await createHighlightAnnotation(token, file.id, {
          page: annotation.page,
          text: annotation.text ?? "",
          note: annotation.note,
          color: annotation.color,
          quadPoints: annotation.quadPoints,
          pageWidth: annotation.pageWidth ?? pageSize.width / scale,
          pageHeight: annotation.pageHeight ?? pageSize.height / scale
        })
        : annotation.rect
          ? await createTextNoteAnnotation(token, file.id, {
            page: annotation.page,
            note: annotation.note ?? "Restored note",
            color: annotation.color,
            rect: annotation.rect,
            pageWidth: annotation.pageWidth ?? pageSize.width / scale,
            pageHeight: annotation.pageHeight ?? pageSize.height / scale
          })
          : null;

      if (restored) {
        updateAnnotations((current) => [...current, restored]);
        setSelectedAnnotationId(restored.id);
      }
      setAnnotationStatus("idle");
    } catch (err) {
      await handleAnnotationError(err, "Failed to restore annotation");
    }
  }

  async function handleSaveSelectedAnnotation() {
    if (!file || !selectedAnnotation) return;

    const note = editingNote.trim();
    const input = {
      color: editingColor,
      baseVersion: selectedAnnotation.version,
      ...(note ? { note } : {})
    };

    if (!navigator.onLine) {
      await queuePendingAnnotationUpdate(selectedAnnotation.id, input);
      return;
    }

    setAnnotationStatus("saving");
    try {
      const updated = await updateAnnotation(token, file.id, selectedAnnotation.id, input);
      updateAnnotations((current) => current.map((annotation) => (annotation.id === updated.id ? updated : annotation)));
      setAnnotationStatus("idle");
    } catch (err) {
      await handleAnnotationError(err, "Failed to update annotation");
    }
  }

  async function handleAnnotationError(err: unknown, fallbackMessage: string) {
    if (err instanceof ApiError && err.status === 409) {
      setAnnotationStatus("conflict");
      setError("This annotation changed on another device. The latest version has been loaded.");
      if (file) {
        try {
          const records = await listAnnotations(token, file.id);
          await cacheAnnotations(file.id, records);
          setAnnotations(records);
        } catch {
          // Keep the conflict visible if refresh also fails.
        }
      }
      return;
    }

    setAnnotationStatus("failed");
    setError(err instanceof Error ? err.message : fallbackMessage);
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
    setZoomMode("custom");
    setScale((current) => Number(Math.min(2.5, Math.max(0.75, current + delta)).toFixed(2)));
  }

  async function applyFitZoom(mode: ZoomMode, cancelled = false) {
    if (!pdf || mode === "custom") return;

    const stage = canvasStageRef.current;
    if (!stage) return;

    const page = await pdf.getPage(pageNumber);
    if (cancelled) return;

    const viewport = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(320, stage.clientWidth - 32);
    const availableHeight = Math.max(320, window.innerHeight - 260);
    const nextScale = mode === "fit_width"
      ? availableWidth / viewport.width
      : Math.min(availableWidth / viewport.width, availableHeight / viewport.height);

    setScale(Number(Math.min(2.5, Math.max(0.75, nextScale)).toFixed(2)));
  }

  function setFitZoom(mode: ZoomMode) {
    setZoomMode(mode);
    void applyFitZoom(mode);
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

  function jumpToAnnotation(annotation: AnnotationRecord) {
    setPageNumber(annotation.page);
    setSelectedAnnotationId(annotation.id);
  }

  const visibleAnnotations = annotations.filter((annotation) => annotation.page === pageNumber && annotation.rect);
  const visibleHighlights = annotations.filter((annotation) => annotation.page === pageNumber && annotation.quadPoints);
  const selectedAnnotation = annotations.find((annotation) => annotation.id === selectedAnnotationId) ?? null;
  const visibleNotes = visibleAnnotations.filter((annotation) => annotation.type === "text_note");
  const annotationList = [...annotations].sort((a, b) => a.page - b.page || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  useEffect(() => {
    setEditingNote(selectedAnnotation?.note ?? "");
    setEditingColor(selectedAnnotation?.color ?? ANNOTATION_COLORS[0]);
  }, [selectedAnnotation?.id, selectedAnnotation?.note, selectedAnnotation?.color]);

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
    <section
      ref={readerRef}
      className="reader-placeholder reader-active"
      onScroll={(event) => setScrollOffset(event.currentTarget.scrollTop)}
    >
      <div className="reader-bar">
        <div>
          <p className="eyebrow">Reader</p>
          <h2>{file.name}</h2>
          <p className="sync-line">Progress: {syncStatus === "idle" ? "ready" : syncStatus}</p>
          <p className="sync-line">Annotations: {annotationStatus === "idle" ? annotations.length : annotationStatus}</p>
          {annotationStatus === "queued" || annotationStatus === "failed" ? (
            <button className="retry-button" onClick={() => void replayPendingAnnotationChanges()}>Retry annotation sync</button>
          ) : null}
          {annotationStatus === "conflict" ? <p className="conflict-line">Conflict detected. Latest annotation version loaded.</p> : null}
          {deletedAnnotation && Date.now() <= deletedAnnotation.expiresAt ? (
            <button className="retry-button" onClick={() => void handleUndoDelete()}>Undo delete</button>
          ) : null}
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
              <button className={zoomMode === "fit_width" ? "secondary active" : "secondary"} onClick={() => setFitZoom("fit_width")}>Fit width</button>
              <button className={zoomMode === "fit_page" ? "secondary active" : "secondary"} onClick={() => setFitZoom("fit_page")}>Fit page</button>
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
      <div ref={canvasStageRef} className="canvas-stage">
        {pdf && pageNumber > 1 ? <AdjacentPdfPage label="Previous page" pageNumber={pageNumber - 1} pdf={pdf} scale={scale} onOpen={() => setPageNumber(pageNumber - 1)} /> : null}
        <div ref={pageLayerRef} className="page-layer" onDoubleClick={handleCreateNote} style={{ width: pageSize.width || undefined, height: pageSize.height || undefined }}>
          <canvas ref={canvasRef} />
          <div ref={textLayerRef} className="text-layer" onMouseUp={() => void handleCreateHighlight()} />
          {pageSize.width && pageSize.height ? (
            <svg className="annotation-layer" viewBox={`0 0 ${pageSize.width} ${pageSize.height}`} aria-label="Page annotations">
              {visibleHighlights.map((annotation) => {
                return annotation.quadPoints!.map((rect, index) => (
                  <HighlightRect
                    annotation={annotation}
                    key={`${annotation.id}-${index}`}
                    pageSize={pageSize}
                    rect={rect}
                    selected={selectedAnnotationId === annotation.id}
                    viewport={viewportRef.current}
                    onSelect={() => setSelectedAnnotationId(annotation.id)}
                  />
                ));
              })}
              {visibleNotes.map((annotation) => {
                const rect = annotation.rect!;
                const renderedRect = renderAnnotationRect(rect, annotation.pageWidth, annotation.pageHeight, pageSize, viewportRef.current);
                const x = renderedRect.x + renderedRect.width / 2;
                const y = renderedRect.y + renderedRect.height / 2;

                return (
                  <g
                    key={annotation.id}
                    className={selectedAnnotationId === annotation.id ? "annotation-marker selected" : "annotation-marker"}
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedAnnotationId(annotation.id);
                    }}
                  >
                    <circle cx={x} cy={y} r="9" fill={annotation.color} />
                    <title>{annotation.note ?? "Note"}</title>
                  </g>
                );
              })}
            </svg>
          ) : null}
        </div>
        {pdf && pageNumber < pdf.numPages ? <AdjacentPdfPage label="Next page" pageNumber={pageNumber + 1} pdf={pdf} scale={scale} onOpen={() => setPageNumber(pageNumber + 1)} /> : null}
      </div>
      <aside className="annotation-panel">
        <div>
          <p className="eyebrow">Annotations</p>
          <h3>{annotationList.length ? `${annotationList.length} total · ${visibleNotes.length + visibleHighlights.length} on this page` : "No annotations yet"}</h3>
          <p className="helper-text">Select text to highlight it. Double-click the page to add a note.</p>
        </div>

        {selectedAnnotation?.type === "text_note" ? (
          <article className="selected-note">
            <strong>Selected note</strong>
            <AnnotationEditor
              color={editingColor}
              note={editingNote}
              onColorChange={setEditingColor}
              onNoteChange={setEditingNote}
              onSave={() => void handleSaveSelectedAnnotation()}
              onDelete={() => void handleDeleteAnnotation(selectedAnnotation.id)}
              saving={annotationStatus === "saving"}
              deleteLabel="Delete note"
            />
          </article>
        ) : null}
        {selectedAnnotation?.type === "highlight" ? (
          <article className="selected-note highlight-note">
            <strong>Selected highlight</strong>
            <p>{selectedAnnotation.text}</p>
            <AnnotationEditor
              color={editingColor}
              note={editingNote}
              onColorChange={setEditingColor}
              onNoteChange={setEditingNote}
              onSave={() => void handleSaveSelectedAnnotation()}
              onDelete={() => void handleDeleteAnnotation(selectedAnnotation.id)}
              saving={annotationStatus === "saving"}
              deleteLabel="Delete highlight"
            />
          </article>
        ) : null}

        <div className="note-list">
          {annotationList.map((annotation, index) => (
            <button
              className={selectedAnnotationId === annotation.id ? "note-item selected" : "note-item"}
              key={annotation.id}
              onClick={() => jumpToAnnotation(annotation)}
            >
              <span>{annotation.type === "highlight" ? "Highlight" : "Note"} {index + 1} · Page {annotation.page}</span>
              <small>{annotation.text ?? annotation.note}</small>
            </button>
          ))}
        </div>
      </aside>
    </section>
  );
}

function AdjacentPdfPage({
  label,
  pageNumber,
  pdf,
  scale,
  onOpen
}: {
  label: string;
  pageNumber: number;
  pdf: pdfjs.PDFDocumentProxy;
  scale: number;
  onOpen: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let task: pdfjs.RenderTask | null = null;

    async function render() {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const context = canvas.getContext("2d");
      if (!context) return;

      canvas.width = viewport.width;
      canvas.height = viewport.height;
      task = page.render({ canvasContext: context, viewport });
      await task.promise.catch(() => undefined);
    }

    void render();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pageNumber, pdf, scale]);

  return (
    <button className="adjacent-page" onClick={onOpen} type="button">
      <span>{label} · Page {pageNumber}</span>
      <canvas ref={canvasRef} />
    </button>
  );
}

function AnnotationEditor({
  color,
  note,
  onColorChange,
  onNoteChange,
  onSave,
  onDelete,
  saving,
  deleteLabel
}: {
  color: string;
  note: string;
  onColorChange: (color: string) => void;
  onNoteChange: (note: string) => void;
  onSave: () => void;
  onDelete: () => void;
  saving: boolean;
  deleteLabel: string;
}) {
  return (
    <>
      <label>
        Note
        <textarea value={note} onChange={(event) => onNoteChange(event.target.value)} rows={4} />
      </label>
      <div className="color-row" aria-label="Annotation color">
        {ANNOTATION_COLORS.map((option) => (
          <button
            aria-label={`Use color ${option}`}
            className={option === color ? "color-swatch selected" : "color-swatch"}
            key={option}
            onClick={() => onColorChange(option)}
            style={{ background: option }}
            type="button"
          />
        ))}
      </div>
      <div className="note-actions">
        <button onClick={onSave} disabled={saving}>Save changes</button>
        <button className="secondary danger" onClick={onDelete} disabled={saving}>{deleteLabel}</button>
      </div>
    </>
  );
}

function HighlightRect({
  annotation,
  rect,
  pageSize,
  viewport,
  selected,
  onSelect
}: {
  annotation: AnnotationRecord;
  rect: AnnotationRect;
  pageSize: { width: number; height: number };
  viewport: pdfjs.PageViewport | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const renderedRect = renderAnnotationRect(rect, annotation.pageWidth, annotation.pageHeight, pageSize, viewport);

  return (
    <rect
      className={selected ? "highlight-rect selected" : "highlight-rect"}
      fill={annotation.color}
      x={renderedRect.x}
      y={renderedRect.y}
      width={renderedRect.width}
      height={renderedRect.height}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
    />
  );
}

function viewportRectToPdfRect(rect: AnnotationRect, viewport: pdfjs.PageViewport): AnnotationRect {
  const start = viewport.convertToPdfPoint(rect.x, rect.y);
  const end = viewport.convertToPdfPoint(rect.x + rect.width, rect.y + rect.height);
  return {
    x: Math.min(start[0], end[0]),
    y: Math.min(start[1], end[1]),
    width: Math.abs(end[0] - start[0]),
    height: Math.abs(end[1] - start[1]),
    coordinateSpace: "pdf"
  };
}

function renderAnnotationRect(
  rect: AnnotationRect,
  pageWidth: number | null,
  pageHeight: number | null,
  pageSize: { width: number; height: number },
  viewport: pdfjs.PageViewport | null
) {
  if (rect.coordinateSpace === "pdf" && viewport) {
    const start = viewport.convertToViewportPoint(rect.x, rect.y);
    const end = viewport.convertToViewportPoint(rect.x + rect.width, rect.y + rect.height);
    return {
      x: Math.min(start[0], end[0]),
      y: Math.min(start[1], end[1]),
      width: Math.abs(end[0] - start[0]),
      height: Math.abs(end[1] - start[1])
    };
  }

  const scaleX = pageWidth ? pageSize.width / pageWidth : 1;
  const scaleY = pageHeight ? pageSize.height / pageHeight : 1;
  return {
    x: rect.x * scaleX,
    y: rect.y * scaleY,
    width: rect.width * scaleX,
    height: rect.height * scaleY
  };
}

function flattenOutline(items: unknown[], level = 0, prefix = ""): OutlineItem[] {
  return items.flatMap((rawItem, index) => {
    const item = rawItem as { title?: string; dest?: string | unknown[] | null; items?: unknown[] };
    const id = `${prefix}${index}`;
    const current = item.title ? [{ id, title: item.title, dest: item.dest ?? null, level }] : [];
    return [...current, ...flattenOutline(item.items ?? [], level + 1, `${id}-`)];
  });
}
