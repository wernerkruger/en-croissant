import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import type { StoredGameReview } from "@/utils/gameReview";

/** Cached move review for the analysis board tab (`Tab.value`). */
export const gameReviewDataFamily = atomFamily((_tabValue: string) => atom<StoredGameReview | null>(null));

export const gameReviewInProgressAtom = atom(false);
