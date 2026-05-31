import { z } from "zod";

export const puzzleSessionStatsSchema = z.object({
    correct: z.number(),
    incorrect: z.number(),
    streak: z.number(),
    bestStreak: z.number(),
    /** Sum of solve times for correct puzzles this session (ms). */
    totalTimeMs: z.number(),
});

export type PuzzleSessionStats = z.infer<typeof puzzleSessionStatsSchema>;

export const puzzleLifetimeStatsSchema = z.object({
    correct: z.number(),
    incorrect: z.number(),
    /** Longest consecutive correct streak across all sessions. */
    bestStreak: z.number(),
    /** Current streak carried across sessions until the next miss. */
    currentStreak: z.number(),
    totalTimeMs: z.number(),
    firstAttemptAt: z.number().optional(),
    lastAttemptAt: z.number().optional(),
});

export type PuzzleLifetimeStats = z.infer<typeof puzzleLifetimeStatsSchema>;

export function emptyPuzzleSessionStats(): PuzzleSessionStats {
    return {
        correct: 0,
        incorrect: 0,
        streak: 0,
        bestStreak: 0,
        totalTimeMs: 0,
    };
}

export function emptyPuzzleLifetimeStats(): PuzzleLifetimeStats {
    return {
        correct: 0,
        incorrect: 0,
        bestStreak: 0,
        currentStreak: 0,
        totalTimeMs: 0,
    };
}

export function applySessionPuzzleResult(
    stats: PuzzleSessionStats,
    completion: "correct" | "incorrect",
    timeSpentMs: number,
): PuzzleSessionStats {
    if (completion === "correct") {
        const streak = stats.streak + 1;
        return {
            ...stats,
            correct: stats.correct + 1,
            streak,
            bestStreak: Math.max(stats.bestStreak, streak),
            totalTimeMs: stats.totalTimeMs + timeSpentMs,
        };
    }
    return {
        ...stats,
        incorrect: stats.incorrect + 1,
        streak: 0,
    };
}

export function applyLifetimePuzzleResult(
    stats: PuzzleLifetimeStats,
    completion: "correct" | "incorrect",
    timeSpentMs: number,
): PuzzleLifetimeStats {
    const now = Date.now();
    if (completion === "correct") {
        const currentStreak = stats.currentStreak + 1;
        return {
            ...stats,
            correct: stats.correct + 1,
            currentStreak,
            bestStreak: Math.max(stats.bestStreak, currentStreak),
            totalTimeMs: stats.totalTimeMs + timeSpentMs,
            firstAttemptAt: stats.firstAttemptAt ?? now,
            lastAttemptAt: now,
        };
    }
    return {
        ...stats,
        incorrect: stats.incorrect + 1,
        currentStreak: 0,
        firstAttemptAt: stats.firstAttemptAt ?? now,
        lastAttemptAt: now,
    };
}

export function puzzleAccuracy(stats: { correct: number; incorrect: number }): number | null {
    const total = stats.correct + stats.incorrect;
    if (total === 0) return null;
    return Math.round((stats.correct / total) * 100);
}

export function puzzleAvgTimeSeconds(stats: {
    correct: number;
    totalTimeMs: number;
}): number | null {
    if (stats.correct === 0 || stats.totalTimeMs <= 0) return null;
    return stats.totalTimeMs / stats.correct / 1000;
}
