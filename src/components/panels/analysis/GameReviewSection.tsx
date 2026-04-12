import { Box, ScrollArea, Stack, Text } from "@mantine/core";
import { IconChartDots } from "@tabler/icons-react";
import { useAtom, useAtomValue } from "jotai";
import { Fragment, memo, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { commands, type GoMode } from "@/bindings";
import ProgressButton from "@/components/common/ProgressButton";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { activeTabAtom, enginesAtom } from "@/state/atoms";
import { gameReviewDataFamily, gameReviewInProgressAtom } from "@/state/gameReviewAtoms";
import { getMainLine } from "@/utils/chess";
import {
    MOVE_REVIEW_KINDS_BEST_TO_WORST,
    buildStoredGameReviewWithLog,
    countReviewKindsBySide,
    hashGameReviewKey,
    parseStoredGameReview,
} from "@/utils/gameReview";
import { getOpeningBook } from "@/utils/openingBook";
import type { LocalEngine } from "@/utils/engines";

const DEFAULT_GO: GoMode = { t: "Depth", c: 18 };

const summaryGrid = {
    display: "grid",
    gridTemplateColumns: "minmax(3.5rem, 1fr) minmax(6rem, auto) minmax(3.5rem, 1fr)",
    columnGap: "var(--mantine-spacing-sm)",
    rowGap: 6,
    alignItems: "center",
} as const;

function GameReviewSection() {
    const { t } = useTranslation();
    const store = useContext(TreeStateContext)!;
    const root = useStore(store, (s) => s.root);
    const addAnalysis = useStore(store, (s) => s.addAnalysis);
    const setReportInProgress = useStore(store, (s) => s.setReportInProgress);

    const activeTab = useAtomValue(activeTabAtom);
    const tabKey = activeTab ?? "";
    const engines = useAtomValue(enginesAtom);
    const localEngines = useMemo(
        () => (engines ?? []).filter((e): e is LocalEngine => e.type === "local"),
        [engines],
    );

    const [reviewData, setReviewData] = useAtom(gameReviewDataFamily(tabKey));
    const [, setGlobalReviewBusy] = useAtom(gameReviewInProgressAtom);
    const [localBusy, setLocalBusy] = useState(false);

    const mainLine = useMemo(() => getMainLine(root), [root]);
    const gameKey = useMemo(
        () => hashGameReviewKey(root.fen, mainLine),
        [root.fen, mainLine],
    );

    const kindCounts = useMemo(
        () => (reviewData ? countReviewKindsBySide(reviewData.entries) : null),
        [reviewData],
    );

    useEffect(() => {
        void getOpeningBook();
    }, []);

    useEffect(() => {
        if (!tabKey || mainLine.length === 0) return;
        setReviewData(null);
        let cancelled = false;
        void commands.loadGameMoveReview({ gameKey }).then((res) => {
            if (cancelled || res.status !== "ok" || !res.data) return;
            const parsed = parseStoredGameReview(res.data);
            if (parsed) setReviewData(parsed);
        });
        return () => {
            cancelled = true;
        };
    }, [tabKey, gameKey, mainLine.length, setReviewData]);

    const runReview = useCallback(async () => {
        if (!tabKey || mainLine.length === 0) return;
        const engine = localEngines[0];
        if (!engine?.path) return;

        setLocalBusy(true);
        setGlobalReviewBusy(true);
        setReportInProgress(true);

        const uciOptions = (engine.settings ?? []).map((s) => ({
            ...s,
            value: s.value?.toString() ?? "",
        }));

        const id = `game_review_${tabKey}`;
        try {
            const analysis = await commands.analyzeGame(
                id,
                engine.path,
                DEFAULT_GO,
                {
                    fen: root.fen,
                    moves: mainLine,
                    annotateNovelties: false,
                    referenceDb: null,
                    reversed: false,
                },
                uciOptions,
            );
            if (analysis.status !== "ok") {
                console.error(analysis.error);
                return;
            }
            addAnalysis(analysis.data, { showVariations: false });
            const built = await buildStoredGameReviewWithLog(analysis.data, mainLine, root.fen, gameKey);
            if (built?.review) {
                setReviewData(built.review);
                const payload = JSON.stringify(built.review);
                void commands.saveGameMoveReview({ gameKey, payload });
                if (built.log) {
                    void commands.appendGameReviewBuildLog({
                        payload: JSON.stringify(built.log),
                    });
                }
            }
        } catch (e) {
            console.error(e);
        } finally {
            setLocalBusy(false);
            setGlobalReviewBusy(false);
            setReportInProgress(false);
        }
    }, [
        tabKey,
        mainLine,
        localEngines,
        root.fen,
        addAnalysis,
        setReviewData,
        gameKey,
        setReportInProgress,
        setGlobalReviewBusy,
    ]);

    const hasMoves = root.children.length > 0;
    const engineReady = localEngines.length > 0 && !!localEngines[0]?.path;

    return (
        <Stack gap="xs" mt="md">
            <Text size="sm" fw={600}>
                {t("Board.Analysis.GameReview")}
            </Text>
            <ProgressButton
                id={`game_review_${tabKey}`}
                redoable
                disabled={!hasMoves || !engineReady}
                initInstalled={!!reviewData && reviewData.entries.length > 0}
                leftIcon={<IconChartDots size="0.875rem" />}
                onClick={() => void runReview()}
                onCancel={() => {
                    void commands.cancelAnalysis(`game_review_${tabKey}`);
                }}
                labels={{
                    action: t("Board.Analysis.ReviewGame"),
                    completed: t("Board.Analysis.ReviewGameDone"),
                    inProgress: t("Board.Analysis.ReviewGameRunning"),
                }}
                inProgress={localBusy}
                setInProgress={setLocalBusy}
            />
            {reviewData && reviewData.entries.length > 0 && kindCounts && (
                <Stack gap="xs">
                    <Text size="xs" c="dimmed">
                        {t("Board.Analysis.ReviewAccuracyWhite", {
                            acc: reviewData.whiteAccuracy,
                            cpl: reviewData.whiteCplAvg,
                        })}
                    </Text>
                    <Text size="xs" c="dimmed">
                        {t("Board.Analysis.ReviewAccuracyBlack", {
                            acc: reviewData.blackAccuracy,
                            cpl: reviewData.blackCplAvg,
                        })}
                    </Text>
                    <Text size="xs" c="dimmed">
                        {t("Board.Analysis.ReviewBuildLogHint")}
                    </Text>
                    <ScrollArea h={280} type="auto" offsetScrollbars>
                        <Box style={summaryGrid}>
                            <Text size="xs" fw={600} ta="right" c="dimmed">
                                {t("Board.Analysis.ReviewSummaryWhite")}
                            </Text>
                            <Text size="xs" fw={600} ta="center" c="dimmed">
                                {t("Board.Analysis.ReviewSummaryMoveType")}
                            </Text>
                            <Text size="xs" fw={600} c="dimmed">
                                {t("Board.Analysis.ReviewSummaryBlack")}
                            </Text>

                            {MOVE_REVIEW_KINDS_BEST_TO_WORST.map((kind) => (
                                <Fragment key={kind}>
                                    <Text size="xs" ta="right" ff="monospace">
                                        {kindCounts.white[kind]}
                                    </Text>
                                    <Text size="xs" ta="center">
                                        {t(`Board.Analysis.ReviewKind.${kind}`)}
                                    </Text>
                                    <Text size="xs" ff="monospace">
                                        {kindCounts.black[kind]}
                                    </Text>
                                </Fragment>
                            ))}
                        </Box>
                    </ScrollArea>
                </Stack>
            )}
        </Stack>
    );
}

export default memo(GameReviewSection);
