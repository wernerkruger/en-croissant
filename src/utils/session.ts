import type { ChessComStats } from "@/utils/chess.com/api";
import type { LichessAccount } from "@/utils/lichess/api";

export type LichessSession = {
    accessToken?: string;
    username: string;
    account: LichessAccount;
};

export type ChessComSession = {
    username: string;
    stats: ChessComStats;
};

export type Session = {
    lichess?: LichessSession;
    chessCom?: ChessComSession;
    player?: string;
    updatedAt: number;
};

/** Display name for a session: custom label, then Chess.com, then Lichess. */
export function getPreferredSessionLabel(session: Session): string {
    const player = session.player?.trim();
    if (player) return player;
    if (session.chessCom?.username) return session.chessCom.username;
    if (session.lichess?.account.username) return session.lichess.account.username;
    return "";
}

/**
 * Default human opponent name when playing locally. Prefers the currently
 * logged-in local profile, then falls back to the first configured session.
 */
export function defaultHumanOpponentName(sessions: Session[], currentUser?: string | null): string {
    const user = currentUser?.trim();
    if (user) return user;
    for (const s of sessions) {
        const name = getPreferredSessionLabel(s);
        if (name) return name;
    }
    return "Player";
}
