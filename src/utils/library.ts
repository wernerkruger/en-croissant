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
