import { useEffect, useRef, useState } from "react";
import { downloadPdf, type FileRecord } from "../lib/api";

const DJVU_LIBRARY_URL = "/vendor/djvu/djvu.js";
const DJVU_VIEWER_URL = "/vendor/djvu/djvu_viewer.js";

declare global {
  interface Window {
    DjVu?: {
      Viewer: new () => DjVuViewer;
    };
  }
}

interface DjVuViewer {
  render(element: HTMLElement): void;
  loadDocument(buffer: ArrayBuffer, name?: string, config?: unknown): Promise<void>;
  configure(config: unknown): void;
  destroy?: () => void;
  reset?: () => void;
}

interface DjvuReaderProps {
  token: string;
  file: FileRecord;
}

let djvuScriptsPromise: Promise<void> | null = null;

const viewerConfig = {
  viewMode: "continuous",
  language: "en",
  uiOptions: {
    hideOpenAndCloseButtons: true,
    hideFullPageSwitch: true,
    hidePrintButton: false,
    hideSaveButton: false
  }
};

export default function DjvuReader({ token, file }: DjvuReaderProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<DjVuViewer | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    async function load() {
      try {
        await loadDjvuScripts();
        if (cancelled || !hostRef.current || !window.DjVu) return;

        hostRef.current.replaceChildren();
        const viewer = new window.DjVu.Viewer();
        viewerRef.current = viewer;
        viewer.render(hostRef.current);
        viewer.configure({ ...viewerConfig, name: file.name });

        const buffer = await downloadPdf(token, file.id);
        if (cancelled) return;
        await viewer.loadDocument(buffer, file.name, { ...viewerConfig, name: file.name });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load DjVu document");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
      disposeDjvuViewer(viewerRef.current);
      viewerRef.current = null;
      hostRef.current?.replaceChildren();
    };
  }, [file.id, file.name, token]);

  return (
    <section className="reader-active djvu-reader-active">
      <div className="djvu-reader-host" ref={hostRef} />
      {isLoading ? <p className="djvu-reader-status">正在加载 DjVu...</p> : null}
      {error ? <p className="djvu-reader-status error">{error}</p> : null}
    </section>
  );
}

function loadDjvuScripts() {
  if (window.DjVu?.Viewer) return Promise.resolve();
  djvuScriptsPromise ??= loadScript(DJVU_LIBRARY_URL).then(() => loadScript(DJVU_VIEWER_URL));
  return djvuScriptsPromise;
}

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing?.dataset.loaded === "true") {
      resolve();
      return;
    }

    const script = existing ?? document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => {
      script.dataset.loaded = "true";
      resolve();
    };
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    if (!existing) document.head.appendChild(script);
  });
}

function disposeDjvuViewer(viewer: DjVuViewer | null) {
  if (!viewer) return;
  if (viewer.destroy) {
    viewer.destroy();
    return;
  }
  viewer.reset?.();
}
