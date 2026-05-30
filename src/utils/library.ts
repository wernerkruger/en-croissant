import { z } from "zod";

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
    host: "access-5020237558.webspace-host.com",
    port: 22,
    username: "su235032",
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
