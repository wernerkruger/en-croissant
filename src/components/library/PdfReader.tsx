import { ActionIcon, Center, Group, Loader, Paper, Stack, Text, Tooltip } from "@mantine/core";
import { IconChevronLeft, IconChevronRight, IconZoomIn, IconZoomOut } from "@tabler/icons-react";
import { readFile } from "@tauri-apps/plugin-fs";
import { error as logError } from "@tauri-apps/plugin-log";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type PDFDocumentProxy, type PDFPageProxy, pdfjsLib } from "@/utils/pdf";

type RenderTask = ReturnType<PDFPageProxy["render"]>;

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 3;

export function PdfReader({
  path,
  initialPage,
  onPageChange,
}: {
  path: string;
  initialPage: number;
  onPageChange: (page: number) => void;
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);

  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(Math.max(1, initialPage));
  const [zoom, setZoom] = useState(1);
  const [containerWidth, setContainerWidth] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Track container width so the page can be re-rendered to fit.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setContainerWidth(el.clientWidth);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Load the document.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const bytes = await readFile(path);
        if (cancelled) return;
        const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
        if (cancelled) {
          doc.destroy();
          return;
        }
        docRef.current = doc;
        setNumPages(doc.numPages);
        setPage((p) => Math.min(Math.max(1, p), doc.numPages));
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          logError(`Failed to load PDF "${path}": ${e}`);
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel?.();
      docRef.current?.destroy?.();
      docRef.current = null;
    };
  }, [path]);

  // Render the current page whenever it, the zoom, or the width changes.
  useEffect(() => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas || loading || containerWidth === 0) return;

    let cancelled = false;
    (async () => {
      try {
        const pdfPage = await doc.getPage(page);
        if (cancelled) return;

        const baseViewport = pdfPage.getViewport({ scale: 1 });
        const fitScale = Math.max(0.1, (containerWidth - 24) / baseViewport.width);
        const scale = Math.min(MAX_ZOOM * 2, fitScale * zoom);
        const dpr = window.devicePixelRatio || 1;
        const viewport = pdfPage.getViewport({ scale });

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        renderTaskRef.current?.cancel?.();
        const task = pdfPage.render({
          canvasContext: ctx,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        renderTaskRef.current = task;
        await task.promise;
      } catch {
        // Render was cancelled or superseded; ignore.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [page, zoom, containerWidth, loading]);

  // Persist reading progress.
  useEffect(() => {
    if (!loading && numPages > 0) {
      onPageChange(page);
    }
  }, [page, loading, numPages, onPageChange]);

  const goPrev = useCallback(() => setPage((p) => Math.max(1, p - 1)), []);
  const goNext = useCallback(() => setPage((p) => Math.min(numPages || p, p + 1)), [numPages]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        goNext();
      }
    },
    [goPrev, goNext],
  );

  return (
    <Stack h="100%" gap="xs">
      <Group justify="center" gap="xs" wrap="nowrap">
        <Tooltip label={t("Library.Reader.PrevPage", "Previous page")}>
          <ActionIcon
            variant="default"
            onClick={goPrev}
            disabled={loading || page <= 1}
            aria-label={t("Library.Reader.PrevPage", "Previous page")}
          >
            <IconChevronLeft size="1rem" />
          </ActionIcon>
        </Tooltip>
        <Text size="sm" miw={110} ta="center">
          {loading
            ? "…"
            : t("Library.Reader.PageOf", "Page {{page}} / {{total}}", {
                page,
                total: numPages,
              })}
        </Text>
        <Tooltip label={t("Library.Reader.NextPage", "Next page")}>
          <ActionIcon
            variant="default"
            onClick={goNext}
            disabled={loading || page >= numPages}
            aria-label={t("Library.Reader.NextPage", "Next page")}
          >
            <IconChevronRight size="1rem" />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={t("Library.Reader.ZoomOut", "Zoom out")}>
          <ActionIcon
            variant="default"
            onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - 0.2))}
            disabled={loading}
            aria-label={t("Library.Reader.ZoomOut", "Zoom out")}
          >
            <IconZoomOut size="1rem" />
          </ActionIcon>
        </Tooltip>
        <Text size="sm" miw={48} ta="center">
          {Math.round(zoom * 100)}%
        </Text>
        <Tooltip label={t("Library.Reader.ZoomIn", "Zoom in")}>
          <ActionIcon
            variant="default"
            onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + 0.2))}
            disabled={loading}
            aria-label={t("Library.Reader.ZoomIn", "Zoom in")}
          >
            <IconZoomIn size="1rem" />
          </ActionIcon>
        </Tooltip>
      </Group>

      <Paper
        withBorder
        flex={1}
        style={{ overflow: "auto", outline: "none" }}
        ref={containerRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        {error ? (
          <Center h="100%" p="md">
            <Stack align="center" gap={4}>
              <Text c="red">{t("Library.Reader.LoadFailed", "Failed to load PDF")}</Text>
              <Text c="dimmed" size="xs" ta="center" style={{ wordBreak: "break-word" }}>
                {error}
              </Text>
            </Stack>
          </Center>
        ) : loading ? (
          <Center h="100%">
            <Loader />
          </Center>
        ) : (
          <Center p="sm">
            <canvas ref={canvasRef} />
          </Center>
        )}
      </Paper>
    </Stack>
  );
}
