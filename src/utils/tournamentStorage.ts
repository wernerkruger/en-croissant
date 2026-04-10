import { resolve } from "@tauri-apps/api/path";
import { exists, mkdir, readDir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { getTournamentsDirectory } from "./directories";
import {
    botDisplayName,
    buildRoundRobinMatches,
    computeStandings,
    type TournamentOutcome,
    type TournamentState,
    TOURNAMENT_FILE_VERSION,
    currentRound,
    isBot,
    matchInvolvesHuman,
    randomBotEloForLevel,
    resolveBotElo,
    simulateBotVsBot,
} from "./tournament";

const PREFIX = "tournament-";
const SUFFIX = ".json";

export async function ensureTournamentsDir(): Promise<string> {
    const dir = await getTournamentsDirectory();
    if (!(await exists(dir))) {
        await mkdir(dir, { recursive: true });
    }
    return dir;
}

export async function tournamentFilePath(dir: string, id: string): Promise<string> {
    return resolve(dir, `${PREFIX}${id}${SUFFIX}`);
}

export async function listTournamentFiles(): Promise<{ id: string; path: string; name: string }[]> {
    const dir = await ensureTournamentsDir();
    const entries = await readDir(dir);
    const out: { id: string; path: string; name: string }[] = [];
    for (const e of entries) {
        if (e.isFile && e.name.startsWith(PREFIX) && e.name.endsWith(SUFFIX)) {
            const id = e.name.slice(PREFIX.length, -SUFFIX.length);
            const full = await resolve(dir, e.name);
            try {
                const raw = await readTextFile(full);
                const data = JSON.parse(raw) as TournamentState;
                out.push({ id, path: full, name: data.name ?? id });
            } catch {
                out.push({ id, path: full, name: id });
            }
        }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
}

export async function loadTournament(id: string): Promise<TournamentState> {
    const dir = await ensureTournamentsDir();
    const path = await tournamentFilePath(dir, id);
    const raw = await readTextFile(path);
    const data = JSON.parse(raw) as TournamentState;
    if (data.version !== TOURNAMENT_FILE_VERSION) {
        throw new Error("Unsupported tournament file version");
    }
    return data;
}

export async function saveTournament(state: TournamentState): Promise<void> {
    const dir = await ensureTournamentsDir();
    const path = await tournamentFilePath(dir, state.id);
    await writeTextFile(path, JSON.stringify(state, null, 2));
}

export function simulatePendingBotGamesInRound(state: TournamentState, round: number): TournamentState {
    const next = structuredClone(state) as TournamentState;
    const roundMatches = next.matches.filter((m) => m.round === round);
    for (const m of roundMatches) {
        if (m.result !== null) continue;
        if (!isBot(next, m.whiteId) || !isBot(next, m.blackId)) continue;
        const wElo = resolveBotElo(next, m.whiteId);
        const bElo = resolveBotElo(next, m.blackId);
        const idx = next.matches.findIndex(
            (x) => x.round === m.round && x.whiteId === m.whiteId && x.blackId === m.blackId,
        );
        if (idx >= 0) {
            next.matches[idx] = {
                ...next.matches[idx],
                result: simulateBotVsBot(wElo, bElo),
            };
        }
    }
    return next;
}

/** Simulate all pending bot–bot games in the first incomplete round. */
export function applyBotSimulationsForCurrentRound(state: TournamentState): TournamentState {
    const r = currentRound(state);
    if (r === null) return state;
    return simulatePendingBotGamesInRound(state, r);
}

export interface NextHumanGamePlan {
    matchIndex: number;
    /** True if actual board colors are swapped vs schedule for human color alternation. */
    resultMappingSwapped: boolean;
}

export function planNextHumanGame(state: TournamentState): NextHumanGamePlan | null {
    const idx = state.matches.findIndex(
        (m) => m.result === null && matchInvolvesHuman(state, m),
    );
    if (idx < 0) return null;

    const m = state.matches[idx];
    const humanOnWhite = !isBot(state, m.whiteId) && isBot(state, m.blackId);
    const humanOnBlack = !isBot(state, m.blackId) && isBot(state, m.whiteId);
    const bothHuman = !isBot(state, m.whiteId) && !isBot(state, m.blackId);

    if (bothHuman) {
        return { matchIndex: idx, resultMappingSwapped: false };
    }

    if (humanOnWhite) {
        return { matchIndex: idx, resultMappingSwapped: !state.nextHumanPlaysWhite };
    }
    if (humanOnBlack) {
        return { matchIndex: idx, resultMappingSwapped: state.nextHumanPlaysWhite };
    }

    return { matchIndex: idx, resultMappingSwapped: false };
}

export function applyScheduleResult(
    state: TournamentState,
    matchIndex: number,
    result: TournamentOutcome,
): TournamentState {
    const next = structuredClone(state) as TournamentState;
    if (matchIndex < 0 || matchIndex >= next.matches.length) return next;
    const m = next.matches[matchIndex];
    if (!m || m.result !== null) return next;

    next.matches[matchIndex] = { ...m, result };

    const m2 = next.matches[matchIndex];
    const oneHumanOneBot =
        matchInvolvesHuman(next, m2) &&
        ((!isBot(next, m2.whiteId) && isBot(next, m2.blackId)) ||
            (!isBot(next, m2.blackId) && isBot(next, m2.whiteId)));
    if (oneHumanOneBot) {
        next.nextHumanPlaysWhite = !next.nextHumanPlaysWhite;
    }

    return next;
}

export async function persistHumanMatchResult(
    id: string,
    matchIndex: number,
    scheduleResult: TournamentOutcome,
): Promise<TournamentState> {
    const st = await loadTournament(id);
    const updated = applyScheduleResult(st, matchIndex, scheduleResult);
    await saveTournament(updated);
    return updated;
}

function formatPoints(p: number): string {
    return Number.isInteger(p) ? String(p) : p.toFixed(1);
}

export function formatStandingsMessage(state: TournamentState): string {
    const rows = computeStandings(state);
    return rows
        .map((r, i) => {
            const played = r.wins + r.draws + r.losses;
            return `${i + 1}. ${r.name}  ${formatPoints(r.points)}  ${played}  ${r.wins}-${r.draws}-${r.losses}`;
        })
        .join("\n");
}

export function createNewTournament(input: {
    name: string;
    level: number;
    timeControl: { seconds: number; increment: number };
    players: { name: string; kind: "human" | "bot" }[];
}): TournamentState {
    const id = crypto.randomUUID();
    const participants = input.players.map((p) => {
        const pid = crypto.randomUUID();
        if (p.kind === "bot") {
            const elo = randomBotEloForLevel(input.level);
            return {
                id: pid,
                displayName: botDisplayName(elo),
                kind: "bot" as const,
                elo,
            };
        }
        return {
            id: pid,
            displayName: p.name.trim() || "Player",
            kind: "human" as const,
        };
    });

    const matches = buildRoundRobinMatches(participants.map((p) => p.id));

    return {
        version: TOURNAMENT_FILE_VERSION,
        id,
        name: input.name.trim() || "Tournament",
        level: input.level,
        timeControl: input.timeControl,
        participants,
        matches,
        nextHumanPlaysWhite: true,
    };
}
