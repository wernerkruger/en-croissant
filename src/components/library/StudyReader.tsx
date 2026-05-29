import { Center, Paper, Stack, Text, ThemeIcon } from "@mantine/core";
import { IconBook } from "@tabler/icons-react";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  currentUserAtom,
  libraryBooksAtom,
  readingProgressAtom,
  studyBookByTabAtom,
} from "@/state/atoms";
import { type Book, readingProgressKey } from "@/utils/library";
import { PdfReader } from "./PdfReader";

/**
 * Renders this study tab's book inside the split-screen layout, persisting
 * reading progress per profile just like the Library page. The book is bound to
 * the owning tab so multiple study tabs each keep their own book.
 */
export default function StudyReader({ tabValue }: { tabValue: string }) {
  const { t } = useTranslation();
  const books = useAtomValue(libraryBooksAtom);
  const studyBookByTab = useAtomValue(studyBookByTabAtom);
  const currentUser = useAtomValue(currentUserAtom) ?? "";
  const setProgress = useSetAtom(readingProgressAtom);
  const progress = useAtomValue(readingProgressAtom);

  const bookId = studyBookByTab[tabValue] ?? null;
  const book = books.find((b) => b.id === bookId) ?? null;

  const updateProgress = useCallback(
    (b: Book, lastPage: number) => {
      setProgress((prev) => {
        const key = readingProgressKey(currentUser, b.id);
        if (prev[key] === lastPage) return prev;
        return { ...prev, [key]: lastPage };
      });
    },
    [currentUser, setProgress],
  );

  if (!book) {
    return (
      <Paper withBorder h="100%">
        <Center h="100%" p="md">
          <Stack align="center" gap="sm">
            <ThemeIcon size={64} radius="100%" variant="light" color="gray">
              <IconBook size={32} />
            </ThemeIcon>
            <Text c="dimmed" ta="center" maw={280}>
              {t("Library.Study.NoBook", "Open a book from the Library to read it here.")}
            </Text>
          </Stack>
        </Center>
      </Paper>
    );
  }

  const lastPage = progress[readingProgressKey(currentUser, book.id)] ?? 1;

  return (
    <Paper withBorder h="100%" p="xs">
      <PdfReader
        key={book.id}
        path={book.path}
        initialPage={lastPage}
        onPageChange={(p) => updateProgress(book, p)}
      />
    </Paper>
  );
}
