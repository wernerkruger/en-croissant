/** Round-robin tournament helpers (single round-robin, Berger pairing). */

export const TOURNAMENT_FILE_VERSION = 1 as const;

export type TournamentOutcome = "1-0" | "0-1" | "1/2-1/2";

export interface TournamentParticipant {
    id: string;
    displayName: string;
    kind: "human" | "bot";
    /** Fixed strength for bots; humans use live ratings when playing. */
    elo?: number;
}

export interface TournamentMatch {
    round: number;
    whiteId: string;
    blackId: string;
    result: TournamentOutcome | null;
}

export interface TournamentState {
    version: typeof TOURNAMENT_FILE_VERSION;
    id: string;
    name: string;
    level: number;
    timeControl: { seconds: number; increment: number };
    participants: TournamentParticipant[];
    matches: TournamentMatch[];
    /** For human vs engine games: next human sits as White (actual board). */
    nextHumanPlaysWhite: boolean;
}

/** Level → inclusive ELO range for random bot strength (UCI limit). */
export const LEVEL_ELO_BOUNDS: ReadonlyArray<readonly [number, number]> = [
    [800, 1000],
    [1000, 1200],
    [1200, 1400],
    [1400, 1600],
    [1600, 1800],
    [1800, 1900],
    [1900, 2000],
    [2000, 2100],
    [2100, 2200],
    [2200, 5000],
];

export function randomBotEloForLevel(level: number, rng: () => number = Math.random): number {
    const idx = Math.min(Math.max(level, 1), 10) - 1;
    const [lo, hi] = LEVEL_ELO_BOUNDS[idx];
    return Math.round(lo + rng() * (hi - lo));
}

export function botDisplayName(elo: number): string {
    return `BOT_${elo}`;
}

/** Berger (circle) pairings: `n` must be even. Returns rounds 1..n-1. */
export function buildRoundRobinMatches(playerIds: string[]): TournamentMatch[] {
    const n = playerIds.length;
    if (n < 2 || n % 2 !== 0) {
        throw new Error("Round-robin requires an even number of players (4–10).");
    }
    const order = [...playerIds];
    const matches: TournamentMatch[] = [];
    const numRounds = n - 1;

    for (let r = 0; r < numRounds; r++) {
        const roundNum = r + 1;
        for (let i = 0; i < n / 2; i++) {
            const a = order[i];
            const b = order[n - 1 - i];
            matches.push({
                round: roundNum,
                whiteId: a,
                blackId: b,
                result: null,
            });
        }
        const fixed = order[0];
        const tail = order.slice(1);
        const last = tail.pop();
        if (last !== undefined) {
            tail.unshift(last);
        }
        order.splice(0, order.length, fixed, ...tail);
    }

    return matches;
}

export function getParticipant(
    state: TournamentState,
    id: string,
): TournamentParticipant | undefined {
    return state.participants.find((p) => p.id === id);
}

export function isBot(state: TournamentState, id: string): boolean {
    return getParticipant(state, id)?.kind === "bot";
}

export function isHuman(state: TournamentState, id: string): boolean {
    return getParticipant(state, id)?.kind === "human";
}

export function matchInvolvesHuman(state: TournamentState, m: TournamentMatch): boolean {
    return isHuman(state, m.whiteId) || isHuman(state, m.blackId);
}

export function allMatchesPlayed(state: TournamentState): boolean {
    return state.matches.every((x) => x.result !== null);
}

/** Smallest round index that still has an unplayed game. */
export function currentRound(state: TournamentState): number | null {
    const pending = state.matches.filter((m) => m.result === null);
    if (pending.length === 0) return null;
    return Math.min(...pending.map((m) => m.round));
}

/** First-move advantage expressed as Elo points for the white side (decisive games). */
const WHITE_FIRST_MOVE_ELO = 38;

/**
 * Share of white wins among decisive games (not draws), using Elo with white bonus.
 */
function decisiveWhiteWinShare(whiteElo: number, blackElo: number): number {
    const rw = whiteElo + WHITE_FIRST_MOVE_ELO;
    return 1 / (1 + 10 ** ((blackElo - rw) / 400));
}

/**
 * Heuristic draw probability: higher when ratings are close and when both players are
 * strong (in line with OTB and engine statistics). Large gaps still keep a small draw
 * tail (swindles, repetition). The lower-rated side still wins a fair share of decisive
 * games via decisiveWhiteWinShare().
 *
 * Coefficients are not fit to a specific database; they can be refit from rated PGN
 * (e.g. TWIC) by estimating P(draw), P(White|¬draw), P(Black|¬draw) vs. mean rating
 * and rating difference.
 */
function estimatedDrawProbability(whiteElo: number, blackElo: number): number {
    const diff = Math.abs(whiteElo - blackElo);
    const avg = (whiteElo + blackElo) / 2;

    const skillFactor = Math.min(1, Math.max(0, (avg - 1000) / 1600));
    const baseAtEqualRating = 0.27 + 0.14 * skillFactor;

    const closeness = Math.exp(-((diff / 480) ** 2));
    const drawFromSkillAndParity = baseAtEqualRating * (0.4 + 0.6 * closeness);

    const tailDraws = 0.05 + 0.05 * Math.exp(-diff / 850);

    return Math.min(0.56, drawFromSkillAndParity + tailDraws);
}

/** Simulate result from schedule white's perspective. */
export function simulateBotVsBot(
    whiteElo: number,
    blackElo: number,
    rng: () => number = Math.random,
): TournamentOutcome {
    const pDraw = estimatedDrawProbability(whiteElo, blackElo);
    const u = rng();
    if (u < pDraw) {
        return "1/2-1/2";
    }
    const wShare = decisiveWhiteWinShare(whiteElo, blackElo);
    const u2 = (u - pDraw) / (1 - pDraw);
    if (u2 < wShare) {
        return "1-0";
    }
    return "0-1";
}

function clampEloForUci(n: number): number {
    return Math.min(5000, Math.max(500, Math.round(n)));
}

export function botUciElo(p: TournamentParticipant): number {
    if (p.kind !== "bot") return 1500;
    return clampEloForUci(p.elo ?? 1500);
}

export function resolveBotElo(state: TournamentState, participantId: string): number {
    const p = getParticipant(state, participantId);
    if (!p || p.kind !== "bot") {
        return 1500;
    }
    return botUciElo(p);
}

export interface StandingRow {
    participantId: string;
    name: string;
    points: number;
    wins: number;
    draws: number;
    losses: number;
}

export function computeStandings(state: TournamentState): StandingRow[] {
    const byId = new Map<string, StandingRow>();
    for (const p of state.participants) {
        byId.set(p.id, {
            participantId: p.id,
            name: p.displayName,
            points: 0,
            wins: 0,
            draws: 0,
            losses: 0,
        });
    }

    for (const m of state.matches) {
        if (!m.result) continue;
        const w = byId.get(m.whiteId);
        const b = byId.get(m.blackId);
        if (!w || !b) continue;

        if (m.result === "1-0") {
            w.points += 1;
            w.wins += 1;
            b.losses += 1;
        } else if (m.result === "0-1") {
            b.points += 1;
            b.wins += 1;
            w.losses += 1;
        } else {
            w.points += 0.5;
            b.points += 0.5;
            w.draws += 1;
            b.draws += 1;
        }
    }

    return [...byId.values()].sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        return a.name.localeCompare(b.name);
    });
}

export function invertScheduleOutcome(o: TournamentOutcome): TournamentOutcome {
    if (o === "1-0") return "0-1";
    if (o === "0-1") return "1-0";
    return "1/2-1/2";
}

/** Map board outcome (actual white won, etc.) to schedule whiteId/blackId result. */
export function boardOutcomeToScheduleResult(
    boardOutcome: TournamentOutcome,
    swappedSchedule: boolean,
): TournamentOutcome {
    return swappedSchedule ? invertScheduleOutcome(boardOutcome) : boardOutcome;
}
