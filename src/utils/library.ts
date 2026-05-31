import { z } from "zod";
import { filezillaSyncDefaults } from "@/utils/filezillaSyncDefaults";

export const bookSchema = z.object({
    id: z.string(),
    title: z.string(),
    fileName: z.string(),
    path: z.string(),
    addedAt: z.number(),
    pageCount: z.number().optional(),
});

export type Book = z.infer<typeof bookSchema>;

/**
 * A game/position saved from the analysis board and pinned to a specific page
 * of a specific book. Shared across local profiles so any reader can open it.
 */
export const pinnedGameSchema = z.object({
    id: z.string(),
    bookId: z.string(),
    page: z.number(),
    name: z.string(),
    pgn: z.string(),
    createdBy: z.string(),
    createdAt: z.number(),
});

export type PinnedGame = z.infer<typeof pinnedGameSchema>;

/** Highlight / underline colors available in the PDF reader. */
export const pdfAnnotationColorSchema = z.enum([
    "yellow",
    "green",
    "blue",
    "pink",
    "orange",
    "purple",
]);

export type PdfAnnotationColor = z.infer<typeof pdfAnnotationColorSchema>;

export const pdfAnnotationTypeSchema = z.enum(["highlight", "underline"]);

export type PdfAnnotationType = z.infer<typeof pdfAnnotationTypeSchema>;

/** Normalized rectangle (0–1) relative to the page display box. */
export const pdfAnnotationRectSchema = z.object({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
});

export type PdfAnnotationRect = z.infer<typeof pdfAnnotationRectSchema>;

/** A user-created mark on a PDF page (stored locally, keyed by user). */
export const pdfAnnotationSchema = z.object({
    id: z.string(),
    user: z.string(),
    bookId: z.string(),
    page: z.number(),
    type: pdfAnnotationTypeSchema,
    color: pdfAnnotationColorSchema,
    rects: z.array(pdfAnnotationRectSchema),
    createdAt: z.number(),
});

export type PdfAnnotation = z.infer<typeof pdfAnnotationSchema>;

export const PDF_ANNOTATION_COLORS: Record<
    PdfAnnotationColor,
    { label: string; highlight: string; underline: string }
> = {
    yellow: { label: "Yellow", highlight: "rgba(255, 235, 59, 0.45)", underline: "#f9a825" },
    green: { label: "Green", highlight: "rgba(129, 199, 132, 0.45)", underline: "#2e7d32" },
    blue: { label: "Blue", highlight: "rgba(100, 181, 246, 0.45)", underline: "#1565c0" },
    pink: { label: "Pink", highlight: "rgba(244, 143, 177, 0.45)", underline: "#c2185b" },
    orange: { label: "Orange", highlight: "rgba(255, 183, 77, 0.45)", underline: "#ef6c00" },
    purple: { label: "Purple", highlight: "rgba(186, 104, 200, 0.45)", underline: "#7b1fa2" },
};

export const PDF_ANNOTATION_COLOR_ORDER: PdfAnnotationColor[] = [
    "yellow",
    "green",
    "blue",
    "pink",
    "orange",
    "purple",
];

/** SFTP cloud-sync configuration. Stored locally (never committed). */
export const syncConfigSchema = z.object({
    enabled: z.boolean(),
    host: z.string(),
    port: z.number(),
    username: z.string(),
    password: z.string(),
    remoteDir: z.string(),
    lastSyncAt: z.number(),
});

export type SyncConfig = z.infer<typeof syncConfigSchema>;

export const defaultSyncConfig: SyncConfig = {
    enabled: false,
    host: filezillaSyncDefaults.host,
    port: filezillaSyncDefaults.port,
    username: filezillaSyncDefaults.username,
    password: "",
    remoteDir: "chess-data",
    lastSyncAt: 0,
};

/** Shape of the manifest.json stored on the server. */
export const syncManifestSchema = z.object({
    books: z.array(bookSchema),
    pinnedGames: z.array(pinnedGameSchema),
    updatedAt: z.number().optional(),
});

export type SyncManifest = z.infer<typeof syncManifestSchema>;

/** Key used to store per-user reading progress for a given book. */
export function readingProgressKey(user: string, bookId: string): string {
    return `${user}::${bookId}`;
}

/** Derive a human readable title from a PDF file name. */
export function titleFromFileName(fileName: string): string {
    return (
        fileName
            .replace(/\.pdf$/i, "")
            .replace(/[_-]+/g, " ")
            .trim() || fileName
    );
}
