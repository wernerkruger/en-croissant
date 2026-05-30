import {
  ActionIcon,
  Button,
  Center,
  Group,
  Loader,
  Menu,
  Paper,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  IconChess,
  IconChevronLeft,
  IconChevronRight,
  IconPin,
  IconTrash,
  IconZoomIn,
  IconZoomOut,
} from "@tabler/icons-react";
import { readFile } from "@tauri-apps/plugin-fs";
import { error as logError } from "@tauri-apps/plugin-log";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { pinnedGamesAtom } from "@/state/atoms";
import type { PinnedGame } from "@/utils/library";
import { type PDFDocumentProxy, type PDFPageProxy, pdfjsLib } from "@/utils/pdf";

type RenderTask = ReturnType<PDFPageProxy["render"]>;

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 3;
const PAGE_GAP = 12;

/**
 * Returns true if the canvas is uniformly one colour, i.e. the render produced
 * nothing visible. Used to detect the WebKit "oversized image draws blank"
 * failure, which does not throw an error.
 */
function isCanvasBlank(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): boolean {
  const { width, height } = canvas;
  if (!width || !height) return true;
  try {
    const data = ctx.getImageData(0, 0, width, height).data;
    const total = data.length;
    const samples = 2000;
    const step = Math.max(1, Math.floor(total / 4 / samples)) * 4;
    let r = -1;
    let g = -1;
    let b = -1;
    let a = -1;
    for (let i = 0; i < total; i += step) {
      if (r === -1) {
        r = data[i];
        g = data[i + 1];
        b = data[i + 2];
        a = data[i + 3];
      } else if (
        data[i] !== r ||
        data[i + 1] !== g ||
        data[i + 2] !== b ||
        data[i + 3] !== a
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function PdfReader({
  path,
  initialPage,
  onPageChange,
  bookId,
  onOpenPinnedGame,
  onPinCurrentPage,
}: {
  path: string;
  initialPage: number;
  onPageChange: (page: number) => void;
  /** When provided, enables pinned-game controls for this book. */
  bookId?: string;
  /** Open a previously pinned game (parent handles tab creation/navigation). */
  onOpenPinnedGame?: (game: PinnedGame) => void;
  /** When provided, shows a button to pin the current board game to this page. */
  onPinCurrentPage?: (page: number) => void;
}) {
  const { t } = useTranslation();
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const allPinnedGames = useAtomValue(pinnedGamesAtom);
  const setPinnedGames = useSetAtom(pinnedGamesAtom);

  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [containerWidth, setContainerWidth] = useState(0);
  const [aspectRatio, setAspectRatio] = useState(1.414); // height / width, from first page
  const [currentPage, setCurrentPage] = useState(Math.max(1, initialPage));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const didInitialScroll = useRef(false);
  const visibilityRef = useRef<Map<number, number>>(new Map());

  // Keep the scroll container width in sync so pages fit horizontally. The
  // update is debounced so transient layout churn (e.g. opening the analysis
  // board / resizing the split) doesn't repeatedly cancel in-flight renders.
  useEffect(() => {
    if (!scrollRoot) return;
    const update = () => setContainerWidth(Math.round(scrollRoot.clientWidth));
    update();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(update, 150);
    });
    observer.observe(scrollRoot);
    return () => {
      if (timeout) clearTimeout(timeout);
      observer.disconnect();
    };
  }, [scrollRoot]);

  // Load the document.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    didInitialScroll.current = false;
    visibilityRef.current.clear();

    (async () => {
      try {
        const bytes = await readFile(path);
        if (cancelled) return;
        const doc = await pdfjsLib.getDocument({
          data: bytes,
          // The WebKitGTK webview silently fails to paint very large images
          // (common in scanned books). Force pdf.js to downscale images above a
          // safe canvas area, and avoid the ImageDecoder path which produces
          // broken/blank JPEGs for some scans.
          canvasMaxAreaInBytes: 16_777_216,
          isImageDecoderSupported: false,
        }).promise;
        if (cancelled) {
          doc.destroy();
          return;
        }
        docRef.current = doc;
        const firstPage = await doc.getPage(1);
        const viewport = firstPage.getViewport({ scale: 1 });
        if (cancelled) {
          doc.destroy();
          return;
        }
        setAspectRatio(viewport.height / viewport.width);
        setNumPages(doc.numPages);
        setCurrentPage((p) => Math.min(Math.max(1, p), doc.numPages));
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
      docRef.current?.destroy?.();
      docRef.current = null;
    };
  }, [path]);

  // Persist reading progress as the visible page changes.
  useEffect(() => {
    if (!loading && numPages > 0) {
      onPageChange(currentPage);
    }
  }, [currentPage, loading, numPages, onPageChange]);

  const reportVisibility = useCallback((page: number, ratio: number) => {
    if (ratio <= 0) {
      visibilityRef.current.delete(page);
    } else {
      visibilityRef.current.set(page, ratio);
    }
    let bestPage = 1;
    let bestRatio = -1;
    for (const [p, r] of visibilityRef.current) {
      if (r > bestRatio) {
        bestRatio = r;
        bestPage = p;
      }
    }
    if (bestRatio > 0) setCurrentPage(bestPage);
  }, []);

  const scrollToPage = useCallback(
    (page: number) => {
      const target = Math.min(Math.max(1, page), numPages || 1);
      const el = scrollRoot?.querySelector<HTMLElement>(`[data-page="${target}"]`);
      el?.scrollIntoView({ block: "start", behavior: "smooth" });
    },
    [scrollRoot, numPages],
  );

  // Jump to the saved page once everything is laid out.
  useEffect(() => {
    if (loading || !scrollRoot || numPages === 0 || containerWidth === 0) return;
    if (didInitialScroll.current) return;
    didInitialScroll.current = true;
    if (initialPage > 1) {
      const el = scrollRoot.querySelector<HTMLElement>(`[data-page="${initialPage}"]`);
      el?.scrollIntoView({ block: "start" });
    }
  }, [loading, scrollRoot, numPages, containerWidth, initialPage]);

  const goPrev = useCallback(() => scrollToPage(currentPage - 1), [scrollToPage, currentPage]);
  const goNext = useCallback(() => scrollToPage(currentPage + 1), [scrollToPage, currentPage]);

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

  const pageWidth = Math.max(0, containerWidth - 24);
  const pagePinnedGames = bookId
    ? allPinnedGames.filter((g) => g.bookId === bookId && g.page === currentPage)
    : [];

  return (
    <Stack h="100%" gap="xs">
      <Group justify="center" gap="xs" wrap="nowrap">
        <Tooltip label={t("Library.Reader.PrevPage", "Previous page")}>
          <ActionIcon
            variant="default"
            onClick={goPrev}
            disabled={loading || currentPage <= 1}
            aria-label={t("Library.Reader.PrevPage", "Previous page")}
          >
            <IconChevronLeft size="1rem" />
          </ActionIcon>
        </Tooltip>
        <Text size="sm" miw={110} ta="center">
          {loading
            ? "…"
            : t("Library.Reader.PageOf", "Page {{page}} / {{total}}", {
                page: currentPage,
                total: numPages,
              })}
        </Text>
        <Tooltip label={t("Library.Reader.NextPage", "Next page")}>
          <ActionIcon
            variant="default"
            onClick={goNext}
            disabled={loading || currentPage >= numPages}
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

        {bookId && onPinCurrentPage && (
          <Tooltip label={t("Library.Reader.PinGame", "Pin current game to this page")}>
            <ActionIcon
              variant="default"
              onClick={() => onPinCurrentPage(currentPage)}
              disabled={loading}
              aria-label={t("Library.Reader.PinGame", "Pin current game to this page")}
            >
              <IconPin size="1rem" />
            </ActionIcon>
          </Tooltip>
        )}

        {bookId && pagePinnedGames.length > 0 && (
          <Menu shadow="md" position="bottom-end" withinPortal>
            <Menu.Target>
              <Button size="xs" variant="light" leftSection={<IconChess size="0.9rem" />}>
                {t("Library.Reader.SavedGames", "Games here ({{count}})", {
                  count: pagePinnedGames.length,
                })}
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>
                {t("Library.Reader.SavedGamesLabel", "Pinned to page {{page}}", {
                  page: currentPage,
                })}
              </Menu.Label>
              {pagePinnedGames.map((game) => (
                <Menu.Item
                  key={game.id}
                  leftSection={<IconChess size="0.9rem" />}
                  onClick={() => onOpenPinnedGame?.(game)}
                  rightSection={
                    <ActionIcon
                      component="div"
                      variant="subtle"
                      color="red"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPinnedGames((prev) => prev.filter((g) => g.id !== game.id));
                      }}
                      aria-label={t("Common.Delete", "Delete")}
                    >
                      <IconTrash size="0.8rem" />
                    </ActionIcon>
                  }
                >
                  {game.name}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>

      <Paper
        withBorder
        flex={1}
        ref={setScrollRoot}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        style={{ overflow: "auto", outline: "none" }}
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
        ) : loading || !docRef.current ? (
          <Center h="100%">
            <Loader />
          </Center>
        ) : (
          <Stack align="center" gap={PAGE_GAP} py={PAGE_GAP}>
            {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNumber) => (
              <PdfPage
                key={pageNumber}
                doc={docRef.current as PDFDocumentProxy}
                pageNumber={pageNumber}
                width={pageWidth}
                zoom={zoom}
                aspectRatio={aspectRatio}
                root={scrollRoot}
                onVisibilityChange={reportVisibility}
              />
            ))}
          </Stack>
        )}
      </Paper>
    </Stack>
  );
}

function PdfPage({
  doc,
  pageNumber,
  width,
  zoom,
  aspectRatio,
  root,
  onVisibilityChange,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  width: number;
  zoom: number;
  aspectRatio: number;
  root: HTMLElement | null;
  onVisibilityChange: (page: number, ratio: number) => void;
}) {
  const { t } = useTranslation();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const taskRef = useRef<RenderTask | null>(null);
  const renderedWidthRef = useRef<number>(0);
  const [visible, setVisible] = useState(false);
  // Whether the canvas currently holds a painted bitmap.
  const [painted, setPainted] = useState(false);
  // The page's own aspect ratio (height / width); null until first measured.
  const [pageAspect, setPageAspect] = useState<number | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  // Track whether this page is near/within the viewport. A modest margin keeps
  // only a few pages alive at once, which matters for high-resolution scans
  // whose decoded source images are very memory-heavy.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          setVisible(entry.isIntersecting);
          onVisibilityChange(pageNumber, entry.isIntersecting ? entry.intersectionRatio : 0);
        }
      },
      { root: root ?? null, rootMargin: "400px 0px", threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      onVisibilityChange(pageNumber, 0);
    };
  }, [root, pageNumber, onVisibilityChange]);

  // Release the (potentially large) canvas bitmap once the page scrolls away,
  // so memory stays bounded even for big scanned books rendered next to a board.
  useEffect(() => {
    if (visible) return;
    taskRef.current?.cancel?.();
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    renderedWidthRef.current = 0;
    setPainted(false);
  }, [visible]);

  // Quantize the render width so sub-pixel/tiny layout shifts don't re-trigger
  // (and cancel) a render. Display sizing still uses the exact width below.
  const renderWidth = width > 0 ? Math.round(width / 8) * 8 : 0;

  // Render the page bitmap at the column's fit-width (in device pixels for
  // sharpness). Crucially this does NOT depend on `zoom`: zooming is applied as
  // pure CSS scaling below, so it can never clear or blank the canvas.
  useEffect(() => {
    if (!visible || renderWidth === 0) return;
    if (renderedWidthRef.current === renderWidth) return;

    let cancelled = false;
    const isCancellation = (e: unknown) =>
      !!e && typeof e === "object" && (e as { name?: string }).name === "RenderingCancelledException";

    (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        setPageAspect(base.height / base.width);
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const baseScale = Math.max(0.1, (renderWidth / base.width) * dpr);

        // High-resolution scans can exceed the webview's canvas/memory limits
        // and silently paint nothing; retry at progressively lower scale until
        // one produces a non-blank result.
        let lastErr: unknown = null;
        let blankAttempts = 0;
        for (const factor of [1, 0.6, 0.4, 0.25]) {
          if (cancelled) return;
          let scale = baseScale * factor;
          const MAX_DIM = 4096;
          const longest = Math.max(base.width, base.height) * scale;
          if (longest > MAX_DIM) scale *= MAX_DIM / longest;
          const viewport = page.getViewport({ scale });
          try {
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            taskRef.current?.cancel?.();
            const task = page.render({ canvasContext: ctx, viewport });
            taskRef.current = task;
            await task.promise;
            if (cancelled) return;
            if (isCanvasBlank(canvas, ctx)) {
              blankAttempts += 1;
              continue; // try a smaller scale
            }
            renderedWidthRef.current = renderWidth;
            setPainted(true);
            setRenderError(null);
            return;
          } catch (e) {
            if (isCancellation(e)) return;
            lastErr = e;
          }
        }
        if (!cancelled) {
          const msg =
            lastErr != null
              ? lastErr instanceof Error
                ? lastErr.message
                : String(lastErr)
              : blankAttempts > 0
                ? "Page rendered blank (image too large for this view)"
                : "Unknown render failure";
          logError(`Failed to render PDF page ${pageNumber}: ${msg}`);
          setRenderError(msg);
        }
      } catch (e) {
        if (!cancelled && !isCancellation(e)) {
          logError(`Failed to render PDF page ${pageNumber}: ${e}`);
          setRenderError(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    return () => {
      cancelled = true;
      taskRef.current?.cancel?.();
    };
  }, [visible, renderWidth, doc, pageNumber]);

  const aspect = pageAspect ?? aspectRatio;
  const displayWidth = width > 0 ? width * zoom : 0;
  const displayHeight = displayWidth * aspect;

  return (
    <div
      ref={wrapperRef}
      data-page={pageNumber}
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minHeight: displayHeight || undefined,
        position: "relative",
      }}
    >
      {/* The bitmap is rendered once at fit-width; zoom only changes the CSS box
          size, so the browser scales the already-painted page. */}
      <canvas
        ref={canvasRef}
        style={{
          width: displayWidth || undefined,
          height: displayHeight || undefined,
          display: painted ? "block" : "none",
          backgroundColor: "#fff",
          boxShadow: "0 1px 6px rgba(0,0,0,0.35)",
        }}
      />
      {!painted &&
        (renderError ? (
          <Stack align="center" gap={4} px="md" style={{ position: "absolute" }}>
            <Text c="red" size="xs" ta="center">
              {t("Library.Reader.PageFailed", "Page {{page}} failed to render", {
                page: pageNumber,
              })}
            </Text>
            <Text c="dimmed" size="xs" ta="center" style={{ wordBreak: "break-word" }}>
              {renderError}
            </Text>
          </Stack>
        ) : visible ? (
          <Loader size="sm" style={{ position: "absolute" }} />
        ) : null)}
    </div>
  );
}
