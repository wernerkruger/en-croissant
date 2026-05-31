import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Card,
  Center,
  Group,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import { useToggle } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconArrowLeft,
  IconBook,
  IconBook2,
  IconChess,
  IconTrash,
  IconUpload,
} from "@tabler/icons-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { resolve } from "@tauri-apps/api/path";
import { useNavigate } from "@tanstack/react-router";
import { open } from "@tauri-apps/plugin-dialog";
import { remove, writeFile } from "@tauri-apps/plugin-fs";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  activeTabAtom,
  currentUserAtom,
  libraryBooksAtom,
  openBookIdAtom,
  readingProgressAtom,
  studyBookByTabAtom,
  syncConfigAtom,
  tabsAtom,
} from "@/state/atoms";
import { getLibraryDir } from "@/utils/directories";
import { type Book, readingProgressKey, titleFromFileName } from "@/utils/library";
import { isSyncConfigComplete, runSync } from "@/utils/sync";
import { createTab, genID } from "@/utils/tabs";
import ConfirmModal from "../common/ConfirmModal";
import { PdfReader } from "./PdfReader";
import { useOpenPinnedGame } from "./useOpenPinnedGame";

function LibraryPage() {
  const { t } = useTranslation();
  const [books, setBooks] = useAtom(libraryBooksAtom);
  const [progress, setProgress] = useAtom(readingProgressAtom);
  const syncConfig = useAtomValue(syncConfigAtom);
  const currentUser = useAtomValue(currentUserAtom) ?? "";
  const [openBookId, setOpenBookId] = useAtom(openBookIdAtom);
  const setTabs = useSetAtom(tabsAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const setStudyBookByTab = useSetAtom(studyBookByTabAtom);
  const navigate = useNavigate();
  const openPinnedGame = useOpenPinnedGame();

  const selected = books.find((b) => b.id === openBookId) ?? null;
  const [uploading, setUploading] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Book | null>(null);
  const [deleteModal, toggleDeleteModal] = useToggle();

  const handleUpload = useCallback(async () => {
    const picked = await open({
      multiple: false,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (typeof picked !== "string") return;

    setUploading(true);
    try {
      const libDir = await getLibraryDir();
      const id = genID();
      const fileName = `${id}.pdf`;
      const dest = await resolve(libDir, fileName);
      const originalName = picked.split(/[\\/]/).pop() || "document.pdf";

      const res = await fetch(convertFileSrc(picked));
      const buffer = await res.arrayBuffer();
      await writeFile(dest, new Uint8Array(buffer));

      const book: Book = {
        id,
        title: titleFromFileName(originalName),
        fileName,
        path: dest,
        addedAt: Date.now(),
      };
      setBooks((prev) => [book, ...prev]);

      if (syncConfig.enabled && isSyncConfigComplete(syncConfig)) {
        runSync().catch(() => {});
      }
    } catch (e) {
      notifications.show({
        title: t("Library.UploadFailed", "Upload failed"),
        message: String(e),
        color: "red",
      });
    } finally {
      setUploading(false);
    }
  }, [setBooks, syncConfig, t]);

  const requestDelete = useCallback(
    (book: Book) => {
      setPendingDelete(book);
      toggleDeleteModal();
    },
    [toggleDeleteModal],
  );

  const confirmDelete = useCallback(async () => {
    const book = pendingDelete;
    if (!book) return;
    await remove(book.path).catch(() => {});
    setBooks((prev) => prev.filter((b) => b.id !== book.id));
    setProgress((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (key.endsWith(`::${book.id}`)) delete next[key];
      }
      return next;
    });
    if (openBookId === book.id) setOpenBookId(null);
    setPendingDelete(null);
    toggleDeleteModal();
  }, [pendingDelete, openBookId, setOpenBookId, setBooks, setProgress, toggleDeleteModal]);

  const openInAnalysis = useCallback(
    async (book: Book) => {
      const tabId = await createTab({
        tab: { name: book.title, type: "study" },
        setTabs,
        setActiveTab,
      });
      setStudyBookByTab((prev) => ({ ...prev, [tabId]: book.id }));
      navigate({ to: "/" });
    },
    [setStudyBookByTab, setTabs, setActiveTab, navigate],
  );

  const updateProgress = useCallback(
    (book: Book, lastPage: number) => {
      setProgress((prev) => {
        const key = readingProgressKey(currentUser, book.id);
        if (prev[key] === lastPage) return prev;
        return { ...prev, [key]: lastPage };
      });
    },
    [currentUser, setProgress],
  );

  if (selected) {
    const lastPage = progress[readingProgressKey(currentUser, selected.id)] ?? 1;
    return (
      <Stack h="100%" p="md" gap="sm">
        <Group gap="sm" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
            <Tooltip label={t("Library.BackToLibrary", "Back to library")}>
              <ActionIcon
                variant="default"
                size="lg"
                onClick={() => setOpenBookId(null)}
                aria-label={t("Library.BackToLibrary", "Back to library")}
              >
                <IconArrowLeft size="1.1rem" />
              </ActionIcon>
            </Tooltip>
            <Title order={4} lineClamp={1}>
              {selected.title}
            </Title>
          </Group>
          <Button
            variant="default"
            leftSection={<IconChess size="1rem" />}
            onClick={() => openInAnalysis(selected)}
            style={{ flexShrink: 0 }}
          >
            {t("Library.OpenAnalysisBoard", "Analysis board")}
          </Button>
        </Group>
        <Box flex={1} style={{ overflow: "hidden" }}>
          <PdfReader
            key={selected.id}
            path={selected.path}
            initialPage={lastPage}
            onPageChange={(p) => updateProgress(selected, p)}
            bookId={selected.id}
            onOpenPinnedGame={openPinnedGame}
          />
        </Box>
      </Stack>
    );
  }

  return (
    <Stack h="100%" p="md" gap="md">
      <ConfirmModal
        title={t("Library.Delete.Title", "Remove book")}
        description={t("Library.Delete.Message", 'Remove "{{title}}" from your library?', {
          title: pendingDelete?.title ?? "",
        })}
        opened={deleteModal}
        onClose={toggleDeleteModal}
        onConfirm={confirmDelete}
      />

      <Group justify="space-between" align="center">
        <Group gap="sm" align="center">
          <IconBook2 size="1.6rem" />
          <Title>{t("Library.Title", "Library")}</Title>
        </Group>
        <Button leftSection={<IconUpload size="1rem" />} onClick={handleUpload} loading={uploading}>
          {t("Library.Upload", "Upload PDF")}
        </Button>
      </Group>

      {books.length === 0 ? (
        <Center flex={1}>
          <Stack align="center" gap="sm">
            <ThemeIcon size={80} radius="100%" variant="light" color="gray">
              <IconBook size={40} />
            </ThemeIcon>
            <Text c="dimmed" fw={500} size="lg">
              {t("Library.Empty", "No documents yet")}
            </Text>
            <Text c="dimmed" size="sm" ta="center" maw={360}>
              {t(
                "Library.EmptyHint",
                "Upload a PDF book or document to start reading. Your progress is saved per profile.",
              )}
            </Text>
            <Text c="dimmed" size="sm" ta="center" maw={400}>
              {t(
                "Library.EmptySyncHint",
                "On a new computer: open Settings → Cloud sync, enter your SFTP password, enable sync, then use Sync now (or restart after login). Books must have been synced from your other machine first.",
              )}
            </Text>
          </Stack>
        </Center>
      ) : (
        <ScrollArea flex={1}>
          <SimpleGrid cols={{ base: 2, sm: 3, md: 4, lg: 5 }} spacing="md">
            {books.map((book) => {
              const lastPage = progress[readingProgressKey(currentUser, book.id)];
              return (
                <Card
                  key={book.id}
                  withBorder
                  padding="sm"
                  radius="md"
                  style={{ cursor: "pointer" }}
                  onClick={() => setOpenBookId(book.id)}
                >
                  <Card.Section
                    withBorder
                    inheritPadding
                    py="xl"
                    style={{ display: "flex", justifyContent: "center" }}
                  >
                    <ThemeIcon size={56} radius="md" variant="light" color="blue">
                      <IconBook size={32} />
                    </ThemeIcon>
                  </Card.Section>
                  <Stack gap={6} mt="sm">
                    <Text fw={600} lineClamp={2} title={book.title}>
                      {book.title}
                    </Text>
                    <Group justify="space-between" align="center">
                      {lastPage ? (
                        <Badge variant="light" size="sm">
                          {t("Library.LastPage", "Page {{page}}", { page: lastPage })}
                        </Badge>
                      ) : (
                        <Badge variant="outline" color="gray" size="sm">
                          {t("Library.Unread", "Unread")}
                        </Badge>
                      )}
                      <Tooltip label={t("Common.Delete", "Delete")}>
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          onClick={(e) => {
                            e.stopPropagation();
                            requestDelete(book);
                          }}
                          aria-label={t("Common.Delete", "Delete")}
                        >
                          <IconTrash size="1rem" />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Stack>
                </Card>
              );
            })}
          </SimpleGrid>
        </ScrollArea>
      )}
    </Stack>
  );
}

export default LibraryPage;
