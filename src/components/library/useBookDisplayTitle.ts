import { useAtom, useAtomValue } from "jotai";
import { useCallback } from "react";
import { bookDisplayTitlesAtom, currentUserAtom } from "@/state/atoms";
import {
    type Book,
    bookDisplayTitleKey,
    getBookDisplayTitle,
} from "@/utils/library";

export function useSetBookDisplayTitle() {
    const user = useAtomValue(currentUserAtom) ?? "";
    const [, setCustomTitles] = useAtom(bookDisplayTitlesAtom);

    return useCallback(
        (book: Book, title: string) => {
            const key = bookDisplayTitleKey(user, book.id);
            const trimmed = title.trim();
            setCustomTitles((prev) => {
                if (!trimmed || trimmed === book.title) {
                    if (!(key in prev)) return prev;
                    const next = { ...prev };
                    delete next[key];
                    return next;
                }
                if (prev[key] === trimmed) return prev;
                return { ...prev, [key]: trimmed };
            });
        },
        [setCustomTitles, user],
    );
}

/** Resolve display titles for library books for the active profile. */
export function useBookDisplayTitles() {
    const user = useAtomValue(currentUserAtom) ?? "";
    const customTitles = useAtomValue(bookDisplayTitlesAtom);

    const titleFor = useCallback(
        (book: Book) => getBookDisplayTitle(book, user, customTitles),
        [customTitles, user],
    );

    return { titleFor };
}
