import { atom } from "jotai";
import type { OpponentSettings } from "@/components/boards/OpponentForm";

export type TournamentLaunchPayload = {
    tournamentId: string;
    matchIndex: number;
    eventName: string;
    player1: OpponentSettings;
    player2: OpponentSettings;
    inputColor: "white" | "black";
    resultMappingSwapped: boolean;
};

export const tournamentLaunchPayloadAtom = atom<TournamentLaunchPayload | null>(null);

export type TournamentActiveContext = {
    tournamentId: string;
    matchIndex: number;
    resultMappingSwapped: boolean;
};

export const tournamentActiveContextAtom = atom<TournamentActiveContext | null>(null);

/** When set, `startGame` uses this as the Event header once, then clears. */
export const tournamentOneShotEventTitleAtom = atom<string | null>(null);

export type TournamentModalPayload = {
    title: string;
    message: string;
    kind: "game_over" | "tournament_complete";
};

export const tournamentModalAtom = atom<TournamentModalPayload | null>(null);
