import type { MoveAnalysis, ScoreValue } from "@/bindings";
import type { OpeningMatch } from "@/utils/openingBook";
import { formatScore, getAccuracy, getCPLoss, getWinChance, normalizeScore } from "@/utils/score";

export const GAME_REVIEW_VERSION = 2 as const;

export type MoveReviewKind =
    | "book"
    | "good"
    | "excellent"
    | "best"
    | "brilliancy"
    | "inaccuracy"
    | "mistake"
    | "blunder";

/** Display / aggregation order: strongest label first, weakest last. */
export const MOVE_REVIEW_KINDS_BEST_TO_WORST: readonly MoveReviewKind[] = [
    "brilliancy",
    "best",
    "excellent",
    "good",
    "book",
    "inaccuracy",
    "mistake",
    "blunder",
];

export interface GameReviewEntry {
    halfMoves: number;
    kind: MoveReviewKind;
    cploss: number;
    accuracy: number;
    /** When `kind === "book"`, from `public/openings/*.tsv` (ECO + name). */
    openingEco?: string;
    openingName?: string;
}

export interface StoredGameReview {
    version: 1 | 2;
    entries: GameReviewEntry[];
    whiteAccuracy: number;
    blackAccuracy: number;
    whiteCplAvg: number;
    blackCplAvg: number;
}

/** One move line appended to `game_review_build_logs.jsonl` (snake_case for logs). */
export interface GameReviewMoveLog {
    half_move: number;
    played_uci: string;
    eval_before: string;
    eval_after: string;
    classification: MoveReviewKind;
    /** Win‑chance loss (percentage points), same signal as the classifier. */
    wcl: number;
    /** Expected points loss — same as centipawn loss here (CPL). */
    epl: number;
    cpl: number;
    is_best: boolean;
    is_sacrifice: boolean;
    opening_eco?: string;
    opening_name?: string;
}

export interface GameReviewBuildLog {
    game_key: string;
    saved_at: string;
    moves: Record<string, GameReviewMoveLog>;
}

function uciKey(uci: string): string {
    return uci.replace(/\+|#/g, "").trim().toLowerCase();
}

function playedMatchesUci(played: string, candidate: string): boolean {
    return uciKey(played) === uciKey(candidate);
}

function winChanceLoss(prev: ScoreValue, next: ScoreValue, color: "white" | "black"): number {
    const prevCP = normalizeScore(prev, color);
    const nextCP = normalizeScore(next, color);
    return getWinChance(prevCP) - getWinChance(nextCP);
}

export interface MoveReviewEvaluation {
    kind: MoveReviewKind;
    prevV: ScoreValue;
    nextV: ScoreValue;
    cpl: number;
    wcl: number;
    acc: number;
    isBest: boolean;
}

/**
 * Core metrics + classification (Chess.com–style labels).
 * Uses centipawn loss, best-move match, sacrifice flag, and win‑chance loss.
 */
export function evaluateMoveForReview(input: {
    playedUci: string;
    beforeAnalysis: MoveAnalysis;
    afterAnalysis: MoveAnalysis;
    color: "white" | "black";
    /** If set, the main line prefix matches this opening from the local TSV book. */
    openingHit: OpeningMatch | null;
}): MoveReviewEvaluation | null {
    const { playedUci, beforeAnalysis, afterAnalysis, color, openingHit } = input;
    const best = beforeAnalysis.best;
    const b0 = best[0];
    const a0 = afterAnalysis.best[0];
    if (!b0?.score?.value || !a0?.score?.value) {
        return null;
    }

    const prevV = b0.score.value;
    const nextV = a0.score.value;
    const cpl = getCPLoss(prevV, nextV, color);
    const wcl = winChanceLoss(prevV, nextV, color);
    const acc = getAccuracy(prevV, nextV, color);
    const bestUci = b0.uciMoves[0] ?? "";
    const isBest = playedMatchesUci(playedUci, bestUci);
    let kind: MoveReviewKind;

    if (openingHit) {
        kind = "book";
    } else if (afterAnalysis.is_sacrifice && !isBest && cpl < 12 && wcl < 8) {
        kind = "brilliancy";
    } else if (isBest && cpl < 25) {
        kind = "best";
    } else if (cpl < 35 && wcl < 6) {
        kind = "excellent";
    } else if (cpl < 50 && wcl < 10) {
        kind = "good";
    } else if (wcl > 20 || cpl >= 100) {
        kind = "blunder";
    } else if (wcl > 10 || cpl >= 75) {
        kind = "mistake";
    } else if (wcl > 5 || cpl >= 50) {
        kind = "inaccuracy";
    } else {
        kind = "good";
    }

    return { kind, prevV, nextV, cpl, wcl, acc, isBest };
}

export function classifyMoveReview(input: {
    playedUci: string;
    beforeAnalysis: MoveAnalysis;
    afterAnalysis: MoveAnalysis;
    color: "white" | "black";
    openingHit?: OpeningMatch | null;
}): MoveReviewKind {
    return (
        evaluateMoveForReview({
            ...input,
            openingHit: input.openingHit ?? null,
        })?.kind ?? "good"
    );
}

function mean(nums: number[]): number {
    if (nums.length === 0) return 0;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function harmonicMean(nums: number[]): number {
    if (nums.length === 0) return 0;
    const s = nums.reduce((acc, n) => acc + 1 / Math.max(n, 0.01), 0);
    return nums.length / s;
}

function emptyKindCounts(): Record<MoveReviewKind, number> {
    return {
        brilliancy: 0,
        best: 0,
        excellent: 0,
        good: 0,
        book: 0,
        inaccuracy: 0,
        mistake: 0,
        blunder: 0,
    };
}

export function countReviewKindsBySide(entries: GameReviewEntry[]): {
    white: Record<MoveReviewKind, number>;
    black: Record<MoveReviewKind, number>;
} {
    const white = emptyKindCounts();
    const black = emptyKindCounts();
    for (const e of entries) {
        const side = e.halfMoves % 2 === 1 ? white : black;
        side[e.kind] += 1;
    }
    return { white, black };
}

/** Build review from `analyze_game` output (same ordering as En Croissant’s `addAnalysis`). */
export async function buildStoredGameReview(
    analysis: MoveAnalysis[],
    mainLineUci: string[],
    rootFen: string,
): Promise<StoredGameReview | null> {
    return (await buildStoredGameReviewWithLog(analysis, mainLineUci, rootFen, undefined))?.review ?? null;
}

/**
 * Like `buildStoredGameReview`. When `gameKey` is set, also returns `log` for JSONL diagnostics
 * (`game_review_build_logs.jsonl` via `append_game_review_build_log`).
 */
export async function buildStoredGameReviewWithLog(
    analysis: MoveAnalysis[],
    mainLineUci: string[],
    rootFen: string,
    gameKey: string | undefined,
): Promise<{ review: StoredGameReview; log?: GameReviewBuildLog } | null> {
    if (analysis.length < 2 || mainLineUci.length === 0) return null;

    const { getOpeningBook, isStandardStartFen } = await import("@/utils/openingBook");
    const bookTrie = isStandardStartFen(rootFen) ? await getOpeningBook() : null;

    const entries: GameReviewEntry[] = [];
    const whiteAcc: number[] = [];
    const blackAcc: number[] = [];
    const whiteCpl: number[] = [];
    const blackCpl: number[] = [];
    const moves: Record<string, GameReviewMoveLog> = {};
    const wantLog = Boolean(gameKey);

    for (let k = 0; k < mainLineUci.length; k++) {
        if (k + 1 >= analysis.length) break;
        const before = analysis[k];
        const after = analysis[k + 1];
        if (!before.best.length || !after.best.length) continue;

        const color: "white" | "black" = k % 2 === 0 ? "white" : "black";
        const openingHit = bookTrie?.lookupPrefix(mainLineUci.slice(0, k + 1)) ?? null;
        const ev = evaluateMoveForReview({
            playedUci: mainLineUci[k]!,
            beforeAnalysis: before,
            afterAnalysis: after,
            color,
            openingHit,
        });
        if (!ev) continue;

        const { kind, prevV, nextV, cpl, wcl, acc, isBest } = ev;

        const half = k + 1;
        entries.push({
            halfMoves: half,
            kind,
            cploss: cpl,
            accuracy: acc,
            ...(openingHit && kind === "book"
                ? { openingEco: openingHit.eco, openingName: openingHit.name }
                : {}),
        });

        if (wantLog) {
            moves[String(half)] = {
                half_move: half,
                played_uci: mainLineUci[k]!,
                eval_before: formatScore(prevV),
                eval_after: formatScore(nextV),
                classification: kind,
                wcl: Math.round(wcl * 100) / 100,
                epl: Math.round(cpl * 100) / 100,
                cpl: Math.round(cpl * 100) / 100,
                is_best: isBest,
                is_sacrifice: after.is_sacrifice,
                ...(openingHit && kind === "book"
                    ? { opening_eco: openingHit.eco, opening_name: openingHit.name }
                    : {}),
            };
        }

        if (color === "white") {
            whiteAcc.push(acc);
            whiteCpl.push(cpl);
        } else {
            blackAcc.push(acc);
            blackCpl.push(cpl);
        }
    }

    if (entries.length === 0) return null;

    const review: StoredGameReview = {
        version: GAME_REVIEW_VERSION,
        entries,
        whiteAccuracy: Math.round(harmonicMean(whiteAcc) * 10) / 10,
        blackAccuracy: Math.round(harmonicMean(blackAcc) * 10) / 10,
        whiteCplAvg: Math.round(mean(whiteCpl) * 10) / 10,
        blackCplAvg: Math.round(mean(blackCpl) * 10) / 10,
    };

    if (!wantLog || !gameKey) {
        return { review };
    }

    const log: GameReviewBuildLog = {
        game_key: gameKey,
        saved_at: new Date().toISOString(),
        moves,
    };

    return { review, log };
}

export function hashGameReviewKey(rootFen: string, mainLineUci: string[]): string {
    const s = `${rootFen}|${mainLineUci.join(",")}`;
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = (h * 33 + s.charCodeAt(i)) | 0;
    }
    return `gr_${(h >>> 0).toString(16)}_${mainLineUci.length}`;
}

export function parseStoredGameReview(json: string): StoredGameReview | null {
    try {
        const o = JSON.parse(json) as StoredGameReview;
        if ((o.version !== 1 && o.version !== 2) || !Array.isArray(o.entries)) return null;
        return o;
    } catch {
        return null;
    }
}
