import {
  Button,
  Checkbox,
  Code,
  Group,
  NumberInput,
  Progress,
  Stack,
  Table,
  Text,
  Textarea,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import type { ChesscomBotManifestEntry, ChesscomUserEntry } from "@/bindings";
import { commands } from "@/bindings";
import { EnginesSelect } from "@/components/boards/EnginesSelect";
import OpenFolderButton from "@/components/common/OpenFolderButton";
import { useProgress } from "@/hooks/useProgress";
import type { LocalEngine } from "@/utils/engines";
import { unwrap } from "@/utils/unwrap";

async function resolveEntries(
  usersText: string,
  entries: ChesscomUserEntry[],
): Promise<ChesscomUserEntry[]> {
  if (entries.length > 0) {
    return entries;
  }
  if (!usersText.trim()) {
    return [];
  }
  return unwrap(await commands.parseChesscomUsersFile(usersText));
}

export function ChessComStyleBots() {
  const { t } = useTranslation();
  const [usersText, setUsersText] = useState("");
  const [entries, setEntries] = useState<ChesscomUserEntry[]>([]);
  const [engine, setEngine] = useState<LocalEngine | null>(null);
  const [maxGames, setMaxGames] = useState(80);
  const [forceRestart, setForceRestart] = useState(false);
  const [downloadProgressId, setDownloadProgressId] = useState<string | null>(null);
  const [buildProgressId, setBuildProgressId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [building, setBuilding] = useState(false);

  const downloadProgress = useProgress(downloadProgressId ?? "");
  const buildProgress = useProgress(buildProgressId ?? "");

  const { data: botsDir } = useSWR("chesscom-bots-dir", async () =>
    unwrap(await commands.getChesscomBotsDirectory()),
  );

  const { data: bots, mutate } = useSWR("chesscom-bots", async () =>
    unwrap(await commands.listChesscomBotProfiles()),
  );

  const activePlayerLabel = useMemo(() => {
    if (!downloading || entries.length === 0 || downloadProgressId === null) {
      return null;
    }
    const p = downloadProgress.progress;
    const idx = Math.min(
      entries.length - 1,
      Math.max(0, Math.floor((p / 100) * entries.length)),
    );
    return entries[idx]?.username ?? null;
  }, [downloading, entries, downloadProgress.progress, downloadProgressId]);

  async function loadUsersFile() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (!selected || typeof selected !== "string") return;
    const content = await readTextFile(selected);
    setUsersText(content);
    const parsed = unwrap(await commands.parseChesscomUsersFile(content));
    setEntries(parsed);
  }

  async function parseInline() {
    if (!usersText.trim()) {
      notifications.show({
        color: "red",
        title: t("Common.Error"),
        message: t("Databases.ChessComBots.ParseEmpty"),
      });
      return;
    }
    const parsed = unwrap(await commands.parseChesscomUsersFile(usersText));
    setEntries(parsed);
    if (parsed.length === 0) {
      notifications.show({
        color: "orange",
        title: t("Common.Error"),
        message: t("Databases.ChessComBots.ParseEmpty"),
      });
    }
  }

  async function downloadGames() {
    let list: ChesscomUserEntry[];
    try {
      list = await resolveEntries(usersText, entries);
      if (list.length === 0) {
        notifications.show({
          color: "red",
          title: t("Common.Error"),
          message: t("Databases.ChessComBots.ParseEmpty"),
        });
        return;
      }
      setEntries(list);
    } catch (e) {
      notifications.show({
        color: "red",
        title: t("Common.Error"),
        message: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    const progressId = `chesscom_dl_${Date.now()}`;
    setDownloadProgressId(progressId);
    setDownloading(true);
    setStatusMessage(t("Databases.ChessComBots.StatusStarting"));

    try {
      const result = unwrap(await commands.downloadChesscomRapidGamesBatch(list, progressId));
      await mutate();
      notifications.show({
        color: "green",
        title: t("Databases.ChessComBots.DownloadDoneTitle"),
        message: t("Databases.ChessComBots.DownloadDoneMessage", {
          downloaded: result.downloaded,
          skipped: result.skipped,
        }),
      });
      setStatusMessage(
        t("Databases.ChessComBots.DownloadDoneShort", {
          downloaded: result.downloaded,
          skipped: result.skipped,
        }),
      );
    } catch (e) {
      notifications.show({
        color: "red",
        title: t("Common.Error"),
        message: e instanceof Error ? e.message : String(e),
      });
      setStatusMessage(null);
    } finally {
      setDownloading(false);
      setDownloadProgressId(null);
    }
  }

  async function buildProfiles() {
    if (!engine?.path) return;
    const progressId = `chesscom_build_${Date.now()}`;
    setBuildProgressId(progressId);
    setBuilding(true);
    setStatusMessage(t("Databases.ChessComBots.StatusBuilding"));

    try {
      const result = unwrap(
        await commands.buildChesscomBotProfilesBatch(
          engine.path,
          maxGames,
          forceRestart,
          progressId,
        ),
      );
      await mutate();
      notifications.show({
        color: "green",
        title: t("Databases.ChessComBots.BuildDoneTitle"),
        message: t("Databases.ChessComBots.BuildDoneMessage", {
          built: result.playersBuilt,
          skipped: result.playersSkippedComplete,
          resumed: result.playersResumed,
          positions: result.totalPositionsAnalyzed,
        }),
      });
      setStatusMessage(
        t("Databases.ChessComBots.BuildDoneShort", {
          built: result.playersBuilt,
          positions: result.totalPositionsAnalyzed,
        }),
      );
    } catch (e) {
      notifications.show({
        color: "red",
        title: t("Common.Error"),
        message: e instanceof Error ? e.message : String(e),
      });
      setStatusMessage(null);
    } finally {
      setBuilding(false);
      setBuildProgressId(null);
    }
  }

  const showDownloadProgress = downloading || downloadProgress.isActive;
  const showBuildProgress = building || buildProgress.isActive;

  return (
    <Stack>
      <Text fz="lg" fw="bold">
        {t("Databases.ChessComBots.Title")}
      </Text>
      <Text fz="sm" c="dimmed">
        {t("Databases.ChessComBots.Description")}
      </Text>

      {botsDir && (
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
            <Text fz="sm" fw={500}>
              {t("Databases.ChessComBots.StorageLabel")}
            </Text>
            <Text fz="xs" c="dimmed">
              {t("Databases.ChessComBots.StorageHint")}
            </Text>
            <Code block style={{ wordBreak: "break-all" }}>
              {botsDir}/games/*.pgn
            </Code>
          </Stack>
          <OpenFolderButton folder={botsDir} />
        </Group>
      )}

      <Group>
        <Button variant="default" onClick={() => void loadUsersFile()}>
          {t("Databases.ChessComBots.LoadFile")}
        </Button>
        <Button variant="light" onClick={() => void parseInline()}>
          {t("Databases.ChessComBots.Parse")}
        </Button>
      </Group>

      <Textarea
        label={t("Databases.ChessComBots.UsersLabel")}
        description={t("Databases.ChessComBots.UsersDesc")}
        minRows={6}
        value={usersText}
        onChange={(e) => setUsersText(e.currentTarget.value)}
        placeholder={"1600:u733985\n1620:Summer_Star"}
      />

      {entries.length > 0 && (
        <Text fz="sm">
          {t("Databases.ChessComBots.ParsedCount", { count: entries.length })}
        </Text>
      )}

      <Button loading={downloading} disabled={building} onClick={() => void downloadGames()}>
        {t("Databases.ChessComBots.DownloadRapid")}
      </Button>

      {showDownloadProgress && (
        <Stack gap={4}>
          <Progress value={downloadProgress.progress} animated={downloading} />
          <Text fz="sm" c="dimmed">
            {activePlayerLabel
              ? t("Databases.ChessComBots.StatusPlayer", {
                  user: activePlayerLabel,
                  current: Math.min(
                    entries.length,
                    Math.max(1, Math.ceil((downloadProgress.progress / 100) * entries.length)),
                  ),
                  total: entries.length,
                  percent: Math.round(downloadProgress.progress),
                })
              : t("Databases.ChessComBots.StatusPercent", {
                  percent: Math.round(downloadProgress.progress),
                })}
          </Text>
        </Stack>
      )}

      <EnginesSelect engine={engine} setEngine={setEngine} />

      <NumberInput
        label={t("Databases.ChessComBots.MaxGames")}
        value={maxGames}
        min={10}
        max={500}
        onChange={(v) => setMaxGames(typeof v === "number" ? v : 80)}
      />

      <Checkbox
        label={t("Databases.ChessComBots.ForceRestart")}
        description={t("Databases.ChessComBots.ForceRestartDesc")}
        checked={forceRestart}
        onChange={(e) => setForceRestart(e.currentTarget.checked)}
      />

      <Button
        loading={building}
        disabled={!engine?.path || (bots?.length ?? 0) === 0 || downloading}
        onClick={() => void buildProfiles()}
      >
        {t("Databases.ChessComBots.BuildProfiles")}
      </Button>

      {showBuildProgress && (
        <Stack gap={4}>
          <Progress value={buildProgress.progress} animated={building} />
          <Text fz="sm" c="dimmed">
            {t("Databases.ChessComBots.StatusPercent", {
              percent: Math.round(buildProgress.progress),
            })}
          </Text>
        </Stack>
      )}

      {statusMessage && !downloading && !building && (
        <Text fz="sm" c="teal">
          {statusMessage}
        </Text>
      )}

      {(bots?.length ?? 0) > 0 && (
        <Table withTableBorder striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t("Common.Name")}</Table.Th>
              <Table.Th>{t("Databases.ChessComBots.Source")}</Table.Th>
              <Table.Th ta="right">ELO</Table.Th>
              <Table.Th>{t("Databases.ChessComBots.ProfileStatus")}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {bots!.map((b: ChesscomBotManifestEntry) => (
              <Table.Tr key={b.id}>
                <Table.Td>{b.botUsername}</Table.Td>
                <Table.Td>{b.sourceUsername}</Table.Td>
                <Table.Td ta="right">{b.targetElo}</Table.Td>
                <Table.Td>
                  {b.profileComplete
                    ? t("Databases.ChessComBots.StatusComplete")
                    : t("Databases.ChessComBots.StatusIncomplete")}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
