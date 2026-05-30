import {
  Button,
  Center,
  Divider,
  Group,
  Modal,
  Paper,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
} from "@mantine/core";
import { IconBook } from "@tabler/icons-react";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import {
  currentUserAtom,
  libraryBooksAtom,
  pinnedGamesAtom,
  readingProgressAtom,
  studyBookByTabAtom,
} from "@/state/atoms";
import { getPGN } from "@/utils/chess";
import { type Book, type PinnedGame, readingProgressKey } from "@/utils/library";
import { genID } from "@/utils/tabs";
import { PdfReader } from "./PdfReader";
import { useOpenPinnedGame } from "./useOpenPinnedGame";

/**
 * Renders this study tab's book inside the split-screen layout, persisting
 * reading progress per profile just like the Library page. The book is bound to
 * the owning tab so multiple study tabs each keep their own book. Because it is
 * mounted inside the analysis board's TreeStateProvider, it can also pin the
 * current board game to the page being read.
 */
export default function StudyReader({ tabValue }: { tabValue: string }) {
  const { t } = useTranslation();
  const books = useAtomValue(libraryBooksAtom);
  const studyBookByTab = useAtomValue(studyBookByTabAtom);
  const currentUser = useAtomValue(currentUserAtom) ?? "";
  const setProgress = useSetAtom(readingProgressAtom);
  const progress = useAtomValue(readingProgressAtom);
  const pinnedGames = useAtomValue(pinnedGamesAtom);
  const setPinnedGames = useSetAtom(pinnedGamesAtom);
  const openPinnedGame = useOpenPinnedGame();

  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const headers = useStore(store, (s) => s.headers);

  const [pinModal, setPinModal] = useState<{ page: number; name: string } | null>(null);

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

  const startPin = useCallback(
    (page: number) => {
      setPinModal({
        page,
        name: t("Library.Reader.DefaultGameName", "Game on page {{page}}", { page }),
      });
    },
    [t],
  );

  const serializeCurrentGame = useCallback(
    () =>
      getPGN(root, {
        headers,
        glyphs: true,
        comments: true,
        variations: true,
        extraMarkups: true,
      }),
    [root, headers],
  );

  const confirmPin = useCallback(() => {
    if (!pinModal || !book) return;
    const name =
      pinModal.name.trim() ||
      t("Library.Reader.DefaultGameName", "Game on page {{page}}", { page: pinModal.page });
    setPinnedGames((prev) => [
      {
        id: genID(),
        bookId: book.id,
        page: pinModal.page,
        name,
        pgn: serializeCurrentGame(),
        createdBy: currentUser,
        createdAt: Date.now(),
      },
      ...prev,
    ]);
    setPinModal(null);
  }, [pinModal, book, serializeCurrentGame, setPinnedGames, currentUser, t]);

  const overwritePin = useCallback(
    (game: PinnedGame) => {
      const pgn = serializeCurrentGame();
      setPinnedGames((prev) =>
        prev.map((g) =>
          g.id === game.id ? { ...g, pgn, createdBy: currentUser, createdAt: Date.now() } : g,
        ),
      );
      setPinModal(null);
    },
    [serializeCurrentGame, setPinnedGames, currentUser],
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
  const existingOnPage = pinModal
    ? pinnedGames.filter((g) => g.bookId === book.id && g.page === pinModal.page)
    : [];

  return (
    <>
      <Modal
        opened={!!pinModal}
        onClose={() => setPinModal(null)}
        title={t("Library.Reader.PinGameTitle", "Pin game to this page")}
        centered
      >
        <Stack>
          <Text size="sm" c="dimmed">
            {t(
              "Library.Reader.PinGameHint",
              "Save the current board position/game and pin it to page {{page}}.",
              { page: pinModal?.page ?? 0 },
            )}
          </Text>

          {existingOnPage.length > 0 && (
            <>
              <Text size="sm" fw={600}>
                {t("Library.Reader.OverwriteExisting", "Replace a game already on this page:")}
              </Text>
              <Stack gap="xs">
                {existingOnPage.map((g) => (
                  <Group key={g.id} justify="space-between" wrap="nowrap">
                    <Text size="sm" lineClamp={1}>
                      {g.name}
                    </Text>
                    <Button
                      size="xs"
                      variant="light"
                      color="orange"
                      onClick={() => overwritePin(g)}
                      style={{ flexShrink: 0 }}
                    >
                      {t("Library.Reader.Overwrite", "Overwrite")}
                    </Button>
                  </Group>
                ))}
              </Stack>
              <Divider
                label={t("Library.Reader.OrSaveNew", "or save as a new game")}
                labelPosition="center"
              />
            </>
          )}

          <TextInput
            data-autofocus
            label={t("Library.Reader.GameName", "Game name")}
            value={pinModal?.name ?? ""}
            onChange={(e) => {
              const value = e.currentTarget.value;
              setPinModal((p) => (p ? { ...p, name: value } : p));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") confirmPin();
            }}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setPinModal(null)}>
              {t("Common.Cancel", "Cancel")}
            </Button>
            <Button onClick={confirmPin}>
              {existingOnPage.length > 0
                ? t("Library.Reader.PinNew", "Pin as new")
                : t("Library.Reader.PinGameConfirm", "Pin to page {{page}}", {
                    page: pinModal?.page ?? 0,
                  })}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Paper withBorder h="100%" p="xs">
        <PdfReader
          key={book.id}
          path={book.path}
          initialPage={lastPage}
          onPageChange={(p) => updateProgress(book, p)}
          bookId={book.id}
          onOpenPinnedGame={openPinnedGame}
          onPinCurrentPage={startPin}
        />
      </Paper>
    </>
  );
}
