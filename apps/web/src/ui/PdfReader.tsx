import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { Bookmark, CheckCircle2, ChevronLeft, ChevronRight, Edit2, FileText, MessageSquare, Palette, PenLine, Search, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
type AnnotationFilter = "all" | "highlight" | "text_note";
type ReaderSideTab = "pages" | "contents" | "bookmarks";
type MobileReaderPanel = "nav" | "search" | "annotations" | null;

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

type NoteDraftInput = Omit<PendingNotePayload["input"], "note">;

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

interface PendingReadingProgressPayload {
  fileId: string;
  page: number;
  zoomValue: number;
  zoomMode: ZoomMode;
  scrollOffset: number;
}

interface DeletedAnnotationSnapshot {
  annotation: AnnotationRecord;
  expiresAt: number;
}

export default function PdfReader({ token, file, syncPulse }: PdfReaderProps) {
  const navigate = useNavigate();
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
  const [, setDeletedAnnotation] = useState<DeletedAnnotationSnapshot | null>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [editingNote, setEditingNote] = useState("");
  const [editingColor, setEditingColor] = useState(ANNOTATION_COLORS[0]);
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchStatus, setSearchStatus] = useState<"idle" | "searching" | "done" | "failed">("idle");
  const [textLayerWarning, setTextLayerWarning] = useState<string | null>(null);
  const [outlineItems, setOutlineItems] = useState<OutlineItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [noteDraftInput, setNoteDraftInput] = useState<NoteDraftInput | null>(null);
  const [noteDraftText, setNoteDraftText] = useState("");
  const [annotationFilter, setAnnotationFilter] = useState<AnnotationFilter>("all");
  const [annotationSearch, setAnnotationSearch] = useState("");
  const [readerSideTab, setReaderSideTab] = useState<ReaderSideTab>("pages");
  const [mobilePanel, setMobilePanel] = useState<MobileReaderPanel>(null);

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
      setSearchOpen(false);
      setSearchQuery("");
      setSearchResults([]);
      setSearchStatus("idle");
      setTextLayerWarning(null);
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

    const replay = () => {
      void replayPendingAnnotationChanges();
      void replayPendingReadingProgress();
    };
    replay();
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
    if (textContent.items.length === 0) {
      setTextLayerWarning("This page has no selectable text. Scanned PDFs can be read and position-noted, but text search and highlights need a text layer.");
    } else {
      setTextLayerWarning(null);
    }

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
      void persistReadingProgress();
    }, 350);

    return () => window.clearTimeout(timeout);
  }, [file, pageNumber, pdf, scale, token, zoomMode, scrollOffset]);

  async function persistReadingProgress() {
    if (!file) return;

    const payload: PendingReadingProgressPayload = { fileId: file.id, page: pageNumber, zoomValue: scale, zoomMode, scrollOffset };
    if (!navigator.onLine) {
      await queuePendingReadingProgress(payload);
      setSyncStatus("failed");
      return;
    }

    try {
      await saveReadingProgress(token, payload.fileId, payload.page, payload.zoomValue, payload.zoomMode, payload.scrollOffset);
      await removePendingReadingProgress(payload.fileId);
      setSyncStatus("synced");
    } catch {
      await queuePendingReadingProgress(payload);
      setSyncStatus("failed");
    }
  }

  async function queuePendingReadingProgress(payload: PendingReadingProgressPayload) {
    await removePendingReadingProgress(payload.fileId);
    await offlineDb.pendingChanges.add({
      entityType: "reading_progress",
      entityId: payload.fileId,
      operation: "update",
      payload,
      createdAt: new Date().toISOString()
    });
  }

  async function removePendingReadingProgress(fileId: string) {
    const pending = await offlineDb.pendingChanges
      .where("entityType")
      .equals("reading_progress")
      .and((change) => change.entityId === fileId)
      .toArray();
    await Promise.all(pending.map((change) => (change.id === undefined ? Promise.resolve() : offlineDb.pendingChanges.delete(change.id))));
  }

  async function replayPendingReadingProgress() {
    if (!navigator.onLine) return;

    const pending = await offlineDb.pendingChanges
      .where("entityType")
      .equals("reading_progress")
      .toArray();
    if (!pending.length) return;

    setSyncStatus("syncing");
    try {
      for (const change of pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        const payload = change.payload as PendingReadingProgressPayload;
        await saveReadingProgress(token, payload.fileId, payload.page, payload.zoomValue, payload.zoomMode, payload.scrollOffset);
        if (change.id !== undefined) await offlineDb.pendingChanges.delete(change.id);
      }
      setSyncStatus("synced");
    } catch {
      setSyncStatus("failed");
    }
  }

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
    setNoteDraftInput({
      page: pageNumber,
      rect: viewportRectToPdfRect({ x, y, width: 18, height: 18 }, viewportRef.current),
      pageWidth: pageSize.width / scale,
      pageHeight: pageSize.height / scale
    });
    setNoteDraftText("");
  }

  async function handleSaveNoteDraft() {
    if (!file || !noteDraftInput || !noteDraftText.trim()) return;

    const input = { ...noteDraftInput, note: noteDraftText.trim() };
    setNoteDraftInput(null);
    setNoteDraftText("");

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
    const annotationIdMap = new Map<string, string>();
    try {
      for (const change of pendingAnnotations) {
        if (change.operation === "create") {
          const payload = change.payload as (PendingNotePayload & { type?: "text_note" }) | (PendingHighlightPayload & { type: "highlight" });
          let created: AnnotationRecord;
          if (payload.type === "highlight") {
            created = await createHighlightAnnotation(token, payload.fileId, payload.input as PendingHighlightPayload["input"]);
          } else {
            created = await createTextNoteAnnotation(token, payload.fileId, payload.input as PendingNotePayload["input"]);
          }
          annotationIdMap.set(change.entityId, created.id);
          await replacePendingAnnotationId(change.entityId, created.id, change.id);
          if (payload.fileId === file?.id) replayedCurrentFile = true;
        } else if (change.operation === "update") {
          const payload = change.payload as PendingAnnotationUpdatePayload;
          await updateAnnotation(token, payload.fileId, annotationIdMap.get(payload.annotationId) ?? payload.annotationId, payload.input);
          if (payload.fileId === file?.id) replayedCurrentFile = true;
        } else if (change.operation === "delete") {
          const payload = change.payload as PendingAnnotationDeletePayload;
          await deleteAnnotation(token, payload.fileId, annotationIdMap.get(payload.annotationId) ?? payload.annotationId);
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

  async function replacePendingAnnotationId(localId: string, serverId: string, excludeChangeId?: number) {
    if (!localId.startsWith("offline-")) return;

    const pending = await offlineDb.pendingChanges
      .where("entityType")
      .equals("annotation")
      .and((change) => change.entityId === localId && change.id !== excludeChangeId)
      .toArray();

    await Promise.all(pending.map((change) => {
      if (change.id === undefined) return Promise.resolve();
      const payload = change.payload as Partial<PendingAnnotationUpdatePayload & PendingAnnotationDeletePayload>;
      return offlineDb.pendingChanges.update(change.id, {
        entityId: serverId,
        payload: { ...payload, annotationId: serverId }
      });
    }));

    updateAnnotations((current) => current.map((annotation) => (annotation.id === localId ? { ...annotation, id: serverId } : annotation)));
  }

  async function handleCreateHighlight() {
    if (!file || !pageSize.width || !pageSize.height || !pageLayerRef.current || !viewportRef.current) return;

    const selection = window.getSelection();
    const selectedText = selection?.toString().trim();
    if (!selection || !selectedText || selection.rangeCount === 0) {
      if (textLayerWarning) setError(textLayerWarning);
      return;
    }

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

  useEffect(() => {
    if (!pdf) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";

      if (event.key === "/" && !isTyping) {
        event.preventDefault();
        openReaderSearch();
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
      let pagesWithoutText = 0;
      for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex += 1) {
        const page = await pdf.getPage(pageIndex);
        const textContent = await page.getTextContent();
        if (textContent.items.length === 0) pagesWithoutText += 1;
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
      if (results.length === 0 && pagesWithoutText > 0) {
        setTextLayerWarning("Some pages have no text layer. Scanned PDFs can be read, but text search and highlights require selectable text.");
      }
      if (results[0]) setPageNumber(results[0].page);
    } catch (err) {
      setSearchStatus("failed");
      setError(err instanceof Error ? err.message : "Failed to search PDF text");
    }
  }

  function openReaderSearch(showMobilePanel = false) {
    setSearchOpen(true);
    if (showMobilePanel) setMobilePanel("search");
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
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
  const filteredAnnotationList = annotationList.filter((annotation) => {
    if (annotationFilter !== "all" && annotation.type !== annotationFilter) return false;
    const query = annotationSearch.trim().toLowerCase();
    if (!query) return true;
    return [annotation.text, annotation.note, String(annotation.page), annotation.type].some((value) => value?.toLowerCase().includes(query));
  });
  const annotationCards = filteredAnnotationList.map((annotation) => ({
      id: annotation.id,
      page: annotation.page,
      type: annotation.type === "highlight" ? "高亮" : "批注",
      text: annotation.text ?? annotation.note ?? "标注内容",
      note: annotation.note,
      time: new Date(annotation.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
      color: annotation.color,
      annotation
    }));

  useEffect(() => {
    setEditingNote(selectedAnnotation?.note ?? "");
    setEditingColor(selectedAnnotation?.color ?? ANNOTATION_COLORS[0]);
  }, [selectedAnnotation?.id, selectedAnnotation?.note, selectedAnnotation?.color]);

  if (!file) {
    return (
      <section className="reader-placeholder">
        <p className="eyebrow">阅读器</p>
        <h2>选择一个 PDF</h2>
        <p>上传 PDF 后，从文件库选择文档即可在这里阅读。</p>
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
        <div className="reader-titlebar">
          <Button variant="ghost" className="reader-back" onClick={() => navigate("/library")}><ChevronLeft size={18} />文件库</Button>
          <h2>{file.name}</h2>
        </div>
        {pdf ? (
          <div className="page-controls">
            <Button variant="ghost" className="reader-icon-button" onClick={() => setPageNumber((page) => Math.max(1, page - 1))} disabled={pageNumber <= 1} aria-label="上一页"><ChevronLeft size={18} /></Button>
            <form
              className="page-jump"
              onSubmit={(event) => {
                event.preventDefault();
                jumpToPage();
              }}
            >
              <Input
                aria-label="Page number"
                inputMode="numeric"
                value={pageInput}
                onBlur={jumpToPage}
                onChange={(event) => setPageInput(event.target.value)}
              />
              <span>/ {pdf.numPages}</span>
            </form>
            <Button variant="ghost" className="reader-icon-button" onClick={() => setPageNumber((page) => Math.min(pdf.numPages, page + 1))} disabled={pageNumber >= pdf.numPages} aria-label="下一页"><ChevronRight size={18} /></Button>
            <span className="reader-divider" />
            <div className="zoom-controls">
              <Button variant="ghost" className="reader-icon-button" onClick={() => changeScale(-0.15)} disabled={scale <= 0.75} aria-label="缩小"><ZoomOut size={17} /></Button>
              <span>{Math.round(scale * 100)}%</span>
              <Button variant="ghost" className="reader-icon-button" onClick={() => changeScale(0.15)} disabled={scale >= 2.5} aria-label="放大"><ZoomIn size={17} /></Button>
            </div>
            <span className="reader-divider" />
            <Button
              variant="ghost"
              className="reader-icon-button"
              type="button"
              aria-label="搜索"
              aria-expanded={searchOpen}
              onClick={() => openReaderSearch()}
            >
              <Search size={18} />
            </Button>
            <Button variant="ghost" className="reader-icon-button" type="button" onClick={() => void handleCreateHighlight()} aria-label="高亮"><PenLine size={18} /></Button>
            <Button variant="ghost" className="reader-icon-button" type="button" aria-label="批注"><MessageSquare size={18} /></Button>
            <Button variant="ghost" className="reader-icon-button" type="button" aria-label="调色板"><Palette size={18} /></Button>
            <span className="reader-divider" />
            <span className="reader-sync"><CheckCircle2 size={17} />{formatReaderStatus(syncStatus === "idle" ? "synced" : syncStatus)}</span>
          </div>
        ) : null}
      </div>

      {isLoading ? <p>正在加载 PDF...</p> : null}
      {error ? <p className="error">{error}</p> : null}
      {textLayerWarning ? <p className="helper-text">{textLayerWarning}</p> : null}
      {pdf ? (
        <form
          className={`search-bar${searchOpen ? " open" : ""}${mobilePanel === "search" ? " mobile-open" : ""}`}
          onSubmit={(event) => {
            event.preventDefault();
            void searchDocument();
          }}
        >
          <Input
            ref={searchInputRef}
            aria-label="Search PDF text"
            placeholder="搜索 PDF 内容"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          <Button disabled={searchStatus === "searching"}>{searchStatus === "searching" ? "搜索中" : "搜索"}</Button>
        </form>
      ) : null}
      {searchOpen && searchStatus === "done" ? (
        <div className="search-results">
          <p>{searchResults.length ? `${searchResults.length} 页匹配` : "未找到匹配文本"}</p>
          {searchResults.slice(0, 8).map((result) => (
            <Button variant="ghost" className="search-result" key={`${result.page}-${result.preview}`} onClick={() => setPageNumber(result.page)}>
              <strong>第 {result.page} 页</strong>
              <span>{result.preview}</span>
            </Button>
          ))}
        </div>
      ) : null}
      {pdf ? (
        <div className={mobilePanel === "nav" ? "reader-side-panel mobile-open" : "reader-side-panel"}>
          <div className="reader-side-tabs" aria-label="Reader navigation">
            <Button variant="ghost" className={readerSideTab === "pages" ? "active" : undefined} onClick={() => setReaderSideTab("pages")}>缩略图</Button>
            <Button variant="ghost" className={readerSideTab === "contents" ? "active" : undefined} onClick={() => setReaderSideTab("contents")}>目录</Button>
            <Button variant="ghost" className={readerSideTab === "bookmarks" ? "active" : undefined} onClick={() => setReaderSideTab("bookmarks")}>书签</Button>
          </div>
          {readerSideTab === "pages" ? (
            <div className="page-mini-list">
              {Array.from({ length: Math.min(pdf.numPages, 40) }, (_, index) => index + 1).map((page) => (
                <Button variant="ghost" className={page === pageNumber ? "active" : undefined} key={page} onClick={() => setPageNumber(page)}>
                  <div className="page-thumb"><FileText size={36} /></div>
                  <span>第 {page} 页</span>
                </Button>
              ))}
            </div>
          ) : null}
          {readerSideTab === "contents" ? (
            <div className="outline-panel">
              <p className="eyebrow">目录</p>
              {outlineItems.length ? (
                <div className="outline-list">
                  {outlineItems.slice(0, 80).map((item) => (
                    <Button variant="ghost" className="outline-item" key={item.id} onClick={() => void jumpToOutlineItem(item)} style={{ paddingLeft: `${0.75 + item.level * 1.1}rem` }}>
                      {item.title}
                    </Button>
                  ))}
                </div>
               ) : <p className="helper-text empty-nav-text">该 PDF 暂无目录</p>}
            </div>
          ) : null}
          {readerSideTab === "bookmarks" ? <div className="bookmark-list"><Bookmark size={18} /><p><strong>第 3 页：研究背景</strong><span>2026-05-08</span></p></div> : null}
        </div>
      ) : null}
      <div ref={canvasStageRef} className="canvas-stage">
        {pdf && pageNumber > 1 ? <AdjacentPdfPage label="上一页" pageNumber={pageNumber - 1} pdf={pdf} scale={scale} onOpen={() => setPageNumber(pageNumber - 1)} /> : null}
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
        {pdf && pageNumber < pdf.numPages ? <AdjacentPdfPage label="下一页" pageNumber={pageNumber + 1} pdf={pdf} scale={scale} onOpen={() => setPageNumber(pageNumber + 1)} /> : null}
      </div>
      <aside className={mobilePanel === "annotations" ? "annotation-panel mobile-open" : "annotation-panel"}>
        <div>
          <h3>标注</h3>
        </div>

        <div className="annotation-tools">
          <div className="annotation-filters" aria-label="Filter annotations">
            <Button variant="ghost" className={annotationFilter === "all" ? "active" : undefined} onClick={() => setAnnotationFilter("all")}>全部</Button>
            <Button variant="ghost" className={annotationFilter === "highlight" ? "active" : undefined} onClick={() => setAnnotationFilter("highlight")}>高亮</Button>
            <Button variant="ghost" className={annotationFilter === "text_note" ? "active" : undefined} onClick={() => setAnnotationFilter("text_note")}>批注</Button>
          </div>
          <Input
            aria-label="Search annotations"
            placeholder="搜索标注内容"
            value={annotationSearch}
            onChange={(event) => setAnnotationSearch(event.target.value)}
          />
        </div>

        {selectedAnnotation?.type === "text_note" ? (
          <article className="selected-note">
            <strong>当前批注</strong>
            <AnnotationEditor
              color={editingColor}
              note={editingNote}
              onColorChange={setEditingColor}
              onNoteChange={setEditingNote}
              onSave={() => void handleSaveSelectedAnnotation()}
              onDelete={() => void handleDeleteAnnotation(selectedAnnotation.id)}
              saving={annotationStatus === "saving"}
              deleteLabel="删除批注"
            />
          </article>
        ) : null}
        {selectedAnnotation?.type === "highlight" ? (
          <article className="selected-note highlight-note">
            <strong>当前高亮</strong>
            <p>{selectedAnnotation.text}</p>
            <AnnotationEditor
              color={editingColor}
              note={editingNote}
              onColorChange={setEditingColor}
              onNoteChange={setEditingNote}
              onSave={() => void handleSaveSelectedAnnotation()}
              onDelete={() => void handleDeleteAnnotation(selectedAnnotation.id)}
              saving={annotationStatus === "saving"}
              deleteLabel="删除高亮"
            />
          </article>
        ) : null}

        <div className="note-list">
          {annotationCards.length === 0 ? <p className="helper-text">当前筛选条件下没有标注。</p> : null}
          {annotationCards.map((item) => (
            <article className={selectedAnnotationId === item.id ? "note-card selected" : "note-card"} key={item.id} onClick={() => jumpToAnnotation(item.annotation)}>
              <header><span>第 {item.page} 页 · {item.type}</span><div><Edit2 size={14} /><Trash2 size={14} /></div></header>
              <mark style={{ backgroundColor: item.color }}>{item.text}</mark>
              {item.note ? <p>备注：{item.note}</p> : null}
              <footer><span>{item.time}</span><span><CheckCircle2 size={14} /> 已同步</span></footer>
            </article>
          ))}
        </div>
      </aside>

      {pdf ? (
        <div className="mobile-reader-actions" aria-label="Reader actions">
          <Button variant="ghost" onClick={() => setMobilePanel((current) => (current === "nav" ? null : "nav"))}>目录</Button>
          <Button variant="ghost" onClick={() => {
            if (mobilePanel === "search") {
              setMobilePanel(null);
              return;
            }
            openReaderSearch(true);
          }}>搜索</Button>
          <Button variant="ghost" onClick={() => setMobilePanel(null)}>{pageNumber} / {pdf.numPages}</Button>
          <Button variant="ghost" onClick={() => setMobilePanel((current) => (current === "annotations" ? null : "annotations"))}>标注</Button>
        </div>
      ) : null}

      <Dialog open={Boolean(noteDraftInput)} onOpenChange={(open) => !open && setNoteDraftInput(null)}>
        <DialogContent className="app-dialog">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handleSaveNoteDraft();
            }}
          >
            <DialogHeader>
              <DialogTitle>添加页面批注</DialogTitle>
              <DialogDescription>为第 {noteDraftInput?.page ?? pageNumber} 页的当前位置添加笔记。</DialogDescription>
            </DialogHeader>
            <Label className="dialog-field">
              批注
              <Textarea autoFocus value={noteDraftText} onChange={(event) => setNoteDraftText(event.target.value)} rows={5} />
            </Label>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setNoteDraftInput(null)}>取消</Button>
              <Button type="submit" disabled={!noteDraftText.trim() || annotationStatus === "saving"}>添加批注</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
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
    <Button variant="ghost" className="adjacent-page" onClick={onOpen} type="button">
      <span>{label} · 第 {pageNumber} 页</span>
      <canvas ref={canvasRef} />
    </Button>
  );
}

function formatReaderStatus(status: "idle" | "syncing" | "synced" | "failed") {
  if (status === "syncing") return "同步中";
  if (status === "synced") return "已同步";
  if (status === "failed") return "同步失败";
  return "就绪";
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
      <Label>
        Note
        <Textarea value={note} onChange={(event) => onNoteChange(event.target.value)} rows={4} />
      </Label>
      <div className="color-row" aria-label="Annotation color">
        {ANNOTATION_COLORS.map((option) => (
          <Button
            aria-label={`Use color ${option}`}
            variant="ghost"
            className={option === color ? "color-swatch selected" : "color-swatch"}
            key={option}
            onClick={() => onColorChange(option)}
            style={{ background: option }}
            type="button"
          />
        ))}
      </div>
      <div className="note-actions">
        <Button onClick={onSave} disabled={saving}>Save changes</Button>
        <Button variant="outline" className="danger" onClick={onDelete} disabled={saving}>{deleteLabel}</Button>
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
