import {
    Button,
    Group,
    InputWrapper,
    Modal,
    NumberInput,
    Paper,
    ScrollArea,
    SegmentedControl,
    Stack,
    Table,
    Text,
    TextInput,
    Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useNavigate } from "@tanstack/react-router";
import { getDefaultStore, useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_TIME_CONTROL } from "@/components/boards/OpponentForm";
import type { OpponentSettings } from "@/components/boards/OpponentForm";
import TimeInput, { type TimeType } from "@/components/common/TimeInput";
import { enginesAtom, gameSameTimeControlAtom } from "@/state/atoms";
import {
    tournamentLaunchPayloadAtom,
    tournamentModalAtom,
} from "@/state/tournamentAtoms";
import type { Engine, LocalEngine } from "@/utils/engines";
import {
    allMatchesPlayed,
    botUciElo,
    computeStandings,
    getParticipant,
    type TournamentParticipant,
    type TournamentState,
} from "@/utils/tournament";
import { ensureActivePlayTab } from "@/utils/tournamentBoardTab";
import {
    applyBotSimulationsForCurrentRound,
    createNewTournament,
    formatStandingsMessage,
    listTournamentFiles,
    loadTournament,
    planNextHumanGame,
    saveTournament,
    type NextHumanGamePlan,
} from "@/utils/tournamentStorage";

const ACTIVE_SESSION_KEY = "tournament-active-id";

type CreateRow = { name: string; kind: "human" | "bot" };

function selectLocalEngine(engines: Engine[] | undefined): LocalEngine | null {
    const list = engines ?? [];
    const locals = list.filter((e): e is LocalEngine => e.type === "local");
    return locals.find((e) => e.enabled !== false && e.path) ?? locals[0] ?? null;
}

function participantToOpponent(
    p: TournamentParticipant,
    engine: LocalEngine,
    tc: { seconds: number; increment: number },
): OpponentSettings {
    const timeFields = {
        timeControl: { seconds: tc.seconds, increment: tc.increment },
        timeUnit: "m" as const,
        incrementUnit: "s" as const,
    };
    if (p.kind === "human") {
        return {
            type: "human",
            name: p.displayName,
            ...timeFields,
        };
    }
    return {
        type: "engine",
        engine: { ...engine, name: p.displayName },
        go: engine.go ?? { t: "Depth", c: 18 },
        engineSettings: engine.settings ?? [],
        limitStrength: true,
        limitElo: botUciElo(p),
        ...timeFields,
    };
}

function buildLaunchPayload(
    state: TournamentState,
    plan: NextHumanGamePlan,
    engine: LocalEngine,
) {
    const m = state.matches[plan.matchIndex];
    const wP = getParticipant(state, m.whiteId)!;
    const bP = getParticipant(state, m.blackId)!;
    const [actualWhite, actualBlack] = plan.resultMappingSwapped ? [bP, wP] : [wP, bP];
    return {
        tournamentId: state.id,
        matchIndex: plan.matchIndex,
        eventName: state.name,
        player1: participantToOpponent(actualWhite, engine, state.timeControl),
        player2: participantToOpponent(actualBlack, engine, state.timeControl),
        inputColor: "white" as const,
        resultMappingSwapped: plan.resultMappingSwapped,
    };
}

export default function TournamentPage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const engines = useAtomValue(enginesAtom);
    const setLaunch = useSetAtom(tournamentLaunchPayloadAtom);
    const setSameTc = useSetAtom(gameSameTimeControlAtom);
    const [modal, setModal] = useAtom(tournamentModalAtom);

    const [savedList, setSavedList] = useState<{ id: string; name: string }[]>([]);
    const [view, setView] = useState<"home" | "create" | "active">("home");
    const [activeId, setActiveId] = useState<string | null>(null);
    const [tournament, setTournament] = useState<TournamentState | null>(null);

    const refreshList = useCallback(async () => {
        const files = await listTournamentFiles();
        setSavedList(files.map((f) => ({ id: f.id, name: f.name })));
    }, []);

    useEffect(() => {
        void refreshList();
    }, [refreshList]);

    useEffect(() => {
        const id = sessionStorage.getItem(ACTIVE_SESSION_KEY);
        if (!id) return;
        void loadTournament(id).then((data) => {
            setTournament(data);
            setActiveId(id);
            setView("active");
        });
    }, []);

    const [createName, setCreateName] = useState("");
    const [createLevel, setCreateLevel] = useState(5);
    const [createCount, setCreateCount] = useState(4);
    const [createRows, setCreateRows] = useState<CreateRow[]>(() =>
        Array.from({ length: 4 }, () => ({ name: "", kind: "human" as const })),
    );
    const [tcSecondsType, setTcSecondsType] = useState<TimeType>("m");
    const [incType, setIncType] = useState<TimeType>("s");
    const [tcMain, setTcMain] = useState(DEFAULT_TIME_CONTROL.seconds);
    const [tcInc, setTcInc] = useState(DEFAULT_TIME_CONTROL.increment ?? 0);

    useEffect(() => {
        const n = Math.min(10, Math.max(4, createCount));
        if (n % 2 !== 0) return;
        setCreateRows((prev) => {
            const next = prev.slice(0, n);
            while (next.length < n) {
                next.push({ name: "", kind: "human" });
            }
            return next;
        });
    }, [createCount]);

    const goHome = () => {
        sessionStorage.removeItem(ACTIVE_SESSION_KEY);
        setView("home");
        setActiveId(null);
        setTournament(null);
    };

    const openTournament = async (id: string) => {
        const data = await loadTournament(id);
        sessionStorage.setItem(ACTIVE_SESSION_KEY, id);
        setTournament(data);
        setActiveId(id);
        setView("active");
    };

    const handleCreate = async () => {
        const n = createRows.length;
        if (n < 4 || n > 10 || n % 2 !== 0) {
            notifications.show({
                color: "red",
                title: t("Tournament.ErrorTitle"),
                message: t("Tournament.EvenPlayersHint"),
            });
            return;
        }
        if (!createRows.some((r) => r.kind === "human")) {
            notifications.show({
                color: "red",
                title: t("Tournament.ErrorTitle"),
                message: t("Tournament.NeedHuman"),
            });
            return;
        }
        const state = createNewTournament({
            name: createName,
            level: createLevel,
            timeControl: { seconds: tcMain, increment: tcInc },
            players: createRows.map((r) => ({
                name: r.name,
                kind: r.kind,
            })),
        });
        await saveTournament(state);
        await refreshList();
        await openTournament(state.id);
    };

    const playNext = async () => {
        if (!activeId) return;
        const engine = selectLocalEngine(engines);
        if (!engine) {
            notifications.show({
                color: "red",
                title: t("Tournament.NoEngineTitle"),
                message: t("Tournament.NoEngineBody"),
            });
            return;
        }

        let state = await loadTournament(activeId);
        const snapshotBefore = JSON.stringify(state.matches);
        state = applyBotSimulationsForCurrentRound(state);
        if (JSON.stringify(state.matches) !== snapshotBefore) {
            await saveTournament(state);
        }
        setTournament(state);

        if (allMatchesPlayed(state)) {
            setModal({
                title: t("Tournament.CompleteTitle"),
                message: `${t("Tournament.FinalStandings")}\n\n${formatStandingsMessage(state)}`,
                kind: "tournament_complete",
            });
            return;
        }

        const plan = planNextHumanGame(state);
        if (!plan) {
            notifications.show({
                color: "orange",
                title: t("Tournament.ErrorTitle"),
                message: t("Tournament.NoHumanGame"),
            });
            return;
        }

        const payload = buildLaunchPayload(state, plan, engine);
        ensureActivePlayTab(t("Home.NewGame"));
        getDefaultStore().set(gameSameTimeControlAtom, true);
        setSameTc(true);
        setLaunch(payload);
        navigate({ to: "/" });
    };

    const standingRows = useMemo(() => {
        if (!tournament) return [];
        return computeStandings(tournament).map((r, idx) => {
            const played = r.wins + r.draws + r.losses;
            const pts = Number.isInteger(r.points) ? String(r.points) : r.points.toFixed(1);
            return (
                <Table.Tr key={r.participantId}>
                    <Table.Td w={56}>{idx + 1}</Table.Td>
                    <Table.Td>{r.name}</Table.Td>
                    <Table.Td ta="right" fw={600}>
                        {pts}
                    </Table.Td>
                    <Table.Td ta="right">{played}</Table.Td>
                    <Table.Td ta="right">{r.wins}</Table.Td>
                    <Table.Td ta="right">{r.draws}</Table.Td>
                    <Table.Td ta="right">{r.losses}</Table.Td>
                </Table.Tr>
            );
        });
    }, [tournament]);

    const scheduleRows = useMemo(() => {
        if (!tournament) return [];
        return tournament.matches.map((m, i) => {
            const w = getParticipant(tournament, m.whiteId)?.displayName ?? "?";
            const b = getParticipant(tournament, m.blackId)?.displayName ?? "?";
            const res = m.result ?? "—";
            return (
                <Table.Tr key={`${m.round}-${i}`}>
                    <Table.Td>{m.round}</Table.Td>
                    <Table.Td>{w}</Table.Td>
                    <Table.Td>{b}</Table.Td>
                    <Table.Td>{res}</Table.Td>
                </Table.Tr>
            );
        });
    }, [tournament]);

    return (
        <ScrollArea style={{ height: "100%" }} type="scroll" offsetScrollbars>
            <Stack p="md" gap="lg" maw={900}>
                <Title order={2}>{t("Tournament.Title")}</Title>

                <Modal opened={modal !== null} onClose={() => setModal(null)} title={modal?.title}>
                    <Text style={{ whiteSpace: "pre-wrap" }}>{modal?.message}</Text>
                    <Group justify="flex-end" mt="md">
                        <Button onClick={() => setModal(null)}>{t("Tournament.ModalDismiss")}</Button>
                    </Group>
                </Modal>

                {view === "home" && (
                    <Stack gap="md">
                        <Group>
                            <Button onClick={() => setView("create")}>{t("Tournament.New")}</Button>
                        </Group>
                        <Text fw={600}>{t("Tournament.SavedList")}</Text>
                        {savedList.length === 0 ? (
                            <Text c="dimmed">{t("Tournament.NoneSaved")}</Text>
                        ) : (
                            <Stack gap="xs">
                                {savedList.map((f) => (
                                    <Paper key={f.id} p="sm" withBorder>
                                        <Group justify="space-between">
                                            <Text>{f.name}</Text>
                                            <Button size="xs" onClick={() => void openTournament(f.id)}>
                                                {t("Tournament.Load")}
                                            </Button>
                                        </Group>
                                    </Paper>
                                ))}
                            </Stack>
                        )}
                    </Stack>
                )}

                {view === "create" && (
                    <Stack gap="md">
                        <Button variant="default" onClick={() => setView("home")}>
                            {t("Tournament.Back")}
                        </Button>
                        <TextInput
                            label={t("Tournament.NameLabel")}
                            value={createName}
                            onChange={(e) => setCreateName(e.target.value)}
                        />
                        <NumberInput
                            label={t("Tournament.LevelLabel")}
                            min={1}
                            max={10}
                            value={createLevel}
                            onChange={(v) => setCreateLevel(typeof v === "number" ? v : 5)}
                        />
                        <NumberInput
                            label={t("Tournament.PlayerCountLabel")}
                            min={4}
                            max={10}
                            value={createCount}
                            onChange={(v) => {
                                const raw = typeof v === "number" ? v : 4;
                                const even = raw % 2 === 0 ? raw : raw + 1;
                                setCreateCount(Math.min(10, Math.max(4, even)));
                            }}
                        />
                        <Text size="sm" c="dimmed">
                            {t("Tournament.EvenPlayersHint")}
                        </Text>
                        <InputWrapper label={t("Board.Opponent.TimeSettings")}>
                            <Group grow align="flex-start">
                                <TimeInput
                                    defaultType="m"
                                    type={tcSecondsType}
                                    onTypeChange={(ty) => setTcSecondsType(ty)}
                                    value={tcMain}
                                    setValue={(v) => setTcMain(v.t === "Time" ? v.c : 0)}
                                />
                                <TimeInput
                                    defaultType="s"
                                    type={incType}
                                    onTypeChange={(ty) => setIncType(ty)}
                                    value={tcInc}
                                    setValue={(v) => setTcInc(v.t === "Time" ? v.c : 0)}
                                />
                            </Group>
                        </InputWrapper>
                        {createRows.map((row, idx) => (
                            <Paper key={idx} p="sm" withBorder>
                                <Stack gap="xs">
                                    <Text size="sm" fw={500}>
                                        {t("Tournament.PlayerN", { n: idx + 1 })}
                                    </Text>
                                    <SegmentedControl
                                        value={row.kind}
                                        onChange={(v) =>
                                            setCreateRows((prev) =>
                                                prev.map((r, i) =>
                                                    i === idx ? { ...r, kind: v as "human" | "bot" } : r,
                                                ),
                                            )
                                        }
                                        data={[
                                            { value: "human", label: t("Board.Opponent.Human") },
                                            { value: "bot", label: t("Tournament.Bot") },
                                        ]}
                                    />
                                    {row.kind === "human" && (
                                        <TextInput
                                            label={t("Tournament.PlayerName")}
                                            value={row.name}
                                            onChange={(e) =>
                                                setCreateRows((prev) =>
                                                    prev.map((r, i) =>
                                                        i === idx ? { ...r, name: e.target.value } : r,
                                                    ),
                                                )
                                            }
                                        />
                                    )}
                                </Stack>
                            </Paper>
                        ))}
                        <Button onClick={() => void handleCreate()}>{t("Tournament.Create")}</Button>
                    </Stack>
                )}

                {view === "active" && tournament && (
                    <Stack gap="md">
                        <Group>
                            <Button variant="default" onClick={goHome}>
                                {t("Tournament.Back")}
                            </Button>
                        </Group>
                        <Title order={4}>{tournament.name}</Title>
                        <Text size="sm" c="dimmed">
                            {t("Tournament.LevelShort", { n: tournament.level })}
                        </Text>
                        <Button onClick={() => void playNext()} disabled={allMatchesPlayed(tournament)}>
                            {t("Tournament.PlayNext")}
                        </Button>
                        <Title order={5}>{t("Tournament.Standings")}</Title>
                        <Paper withBorder radius="md" p={0} style={{ overflow: "hidden" }}>
                            <Table striped highlightOnHover verticalSpacing="sm" withTableBorder>
                                <Table.Thead bg="var(--mantine-color-body)">
                                    <Table.Tr>
                                        <Table.Th style={{ width: "3.5rem" }}>
                                            <Text size="xs" tt="uppercase" fw={700} c="dimmed">
                                                {t("Tournament.StandingsPosition")}
                                            </Text>
                                        </Table.Th>
                                        <Table.Th>
                                            <Text size="xs" tt="uppercase" fw={700} c="dimmed">
                                                {t("Tournament.StandingsName")}
                                            </Text>
                                        </Table.Th>
                                        <Table.Th style={{ textAlign: "right", width: "5rem" }}>
                                            <Text size="xs" tt="uppercase" fw={700} c="dimmed">
                                                {t("Tournament.StandingsPoints")}
                                            </Text>
                                        </Table.Th>
                                        <Table.Th style={{ textAlign: "right", width: "4.5rem" }}>
                                            <Text size="xs" tt="uppercase" fw={700} c="dimmed">
                                                {t("Tournament.StandingsPlayed")}
                                            </Text>
                                        </Table.Th>
                                        <Table.Th style={{ textAlign: "right", width: "3.5rem" }}>
                                            <Text size="xs" tt="uppercase" fw={700} c="dimmed">
                                                {t("Tournament.StandingsWon")}
                                            </Text>
                                        </Table.Th>
                                        <Table.Th style={{ textAlign: "right", width: "4rem" }}>
                                            <Text size="xs" tt="uppercase" fw={700} c="dimmed">
                                                {t("Tournament.StandingsDrawn")}
                                            </Text>
                                        </Table.Th>
                                        <Table.Th style={{ textAlign: "right", width: "3.5rem" }}>
                                            <Text size="xs" tt="uppercase" fw={700} c="dimmed">
                                                {t("Tournament.StandingsLost")}
                                            </Text>
                                        </Table.Th>
                                    </Table.Tr>
                                </Table.Thead>
                                <Table.Tbody>{standingRows}</Table.Tbody>
                            </Table>
                        </Paper>
                        <Title order={5}>{t("Tournament.Schedule")}</Title>
                        <Table striped highlightOnHover withTableBorder>
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>{t("Tournament.RoundCol")}</Table.Th>
                                    <Table.Th>{t("Tournament.WhiteCol")}</Table.Th>
                                    <Table.Th>{t("Tournament.BlackCol")}</Table.Th>
                                    <Table.Th>{t("Tournament.ResultCol")}</Table.Th>
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>{scheduleRows}</Table.Tbody>
                        </Table>
                    </Stack>
                )}
            </Stack>
        </ScrollArea>
    );
}
