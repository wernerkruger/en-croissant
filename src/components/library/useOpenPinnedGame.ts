import { useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import {
  activeTabAtom,
  currentUserAtom,
  readingProgressAtom,
  studyBookByTabAtom,
  tabsAtom,
} from "@/state/atoms";
import { type PinnedGame, readingProgressKey } from "@/utils/library";
import { createTab } from "@/utils/tabs";

/**
 * Opens a pinned game in a new study tab: loads its PGN onto the analysis
 * board, re-attaches the originating book, jumps the book to the pinned page,
 * and navigates to the boards view.
 */
export function useOpenPinnedGame() {
  const setTabs = useSetAtom(tabsAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const setStudyBookByTab = useSetAtom(studyBookByTabAtom);
  const setProgress = useSetAtom(readingProgressAtom);
  const currentUser = useAtomValue(currentUserAtom) ?? "";
  const navigate = useNavigate();

  return useCallback(
    async (game: PinnedGame) => {
      const tabId = await createTab({
        tab: { name: game.name, type: "study" },
        setTabs,
        setActiveTab,
        pgn: game.pgn,
      });
      setStudyBookByTab((prev) => ({ ...prev, [tabId]: game.bookId }));
      setProgress((prev) => ({
        ...prev,
        [readingProgressKey(currentUser, game.bookId)]: game.page,
      }));
      navigate({ to: "/" });
    },
    [setTabs, setActiveTab, setStudyBookByTab, setProgress, currentUser, navigate],
  );
}
