import { Badge, Group, Stack, Table, Text } from "@mantine/core";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import type { EncEngineAccountSummary, PlayerGameInfo } from "@/bindings";
import { commands } from "@/bindings";
import { sessionsAtom } from "@/state/atoms";
import { getStats } from "@/utils/chess.com/api";
import { capitalize } from "@/utils/format";
import { getTimeControl, parsePgnDateUtcMs } from "@/utils/timeControl";
import type { Session } from "@/utils/session";

export type RatingRow = {
  site: string;
  category: string;
  rating: number;
  games?: number;
  diff?: number;
  source: "account" | "games";
};

function sessionMatchesPlayer(session: Session, playerName: string): boolean {
  const n = playerName.toLowerCase();
  return (
    session.player?.toLowerCase() === n ||
    session.lichess?.username.toLowerCase() === n ||
    session.chessCom?.username.toLowerCase() === n
  );
}

function ratingsFromSessions(sessions: Session[], playerName: string): RatingRow[] {
  const rows: RatingRow[] = [];
  for (const session of sessions.filter((s) => sessionMatchesPlayer(s, playerName))) {
    if (session.lichess?.account.perfs) {
      const speeds = ["bullet", "blitz", "rapid", "classical", "ultraBullet"] as const;
      for (const speed of speeds) {
        const perf = session.lichess.account.perfs[speed];
        if (perf && perf.games > 0) {
          rows.push({
            site: "Lichess",
            category: speed === "ultraBullet" ? "UltraBullet" : capitalize(speed),
            rating: perf.rating,
            games: perf.games,
            diff: perf.prog,
            source: "account",
          });
        }
      }
    }
    if (session.chessCom?.stats) {
      for (const stat of getStats(session.chessCom.stats)) {
        rows.push({
          site: "Chess.com",
          category: stat.label,
          rating: stat.value,
          source: "account",
        });
      }
    }
  }
  return rows;
}

function ratingsFromEncSummary(summary: EncEngineAccountSummary): RatingRow[] {
  if (!summary.registered) return [];
  return summary.perfs.map((p) => ({
      site: "En Croissant",
      category: capitalize(p.key),
      rating: p.rating,
      games: p.games,
      source: "account" as const,
    }));
}

function ratingsFromGameHistory(info: PlayerGameInfo): RatingRow[] {
  const latest = new Map<string, { rating: number; games: number; date: number }>();
  for (const block of info.site_stats_data) {
    for (const game of block.data) {
      const tc = getTimeControl(block.site, game.time_control) || "Other";
      const key = `${block.site}\0${tc}`;
      const date = parsePgnDateUtcMs(game.date);
      const prev = latest.get(key);
      if (!prev || date >= prev.date) {
        latest.set(key, {
          rating: game.player_elo,
          games: (prev?.games ?? 0) + 1,
          date,
        });
      }
    }
  }
  return Array.from(latest.entries()).map(([key, v]) => {
    const [site, category] = key.split("\0");
    return {
      site,
      category: capitalize(category),
      rating: v.rating,
      games: v.games,
      source: "games" as const,
    };
  });
}

function mergeRatingRows(rows: RatingRow[]): RatingRow[] {
  const byKey = new Map<string, RatingRow>();
  for (const row of rows) {
    const key = `${row.site}\0${row.category}`.toLowerCase();
    const existing = byKey.get(key);
    if (!existing || row.source === "account") {
      byKey.set(key, row);
    }
  }
  return Array.from(byKey.values()).sort(
    (a, b) => a.site.localeCompare(b.site) || a.category.localeCompare(b.category),
  );
}

export function useAllPlayerRatings(playerName: string, info: PlayerGameInfo) {
  const sessions = useAtomValue(sessionsAtom);
  const { data: encSummary } = useSWR(
    playerName ? ["enc-account-summary", playerName] : null,
    async () => {
      const r = await commands.getEncroissantEngineAccountSummary(playerName);
      if (r.status !== "ok") throw new Error(r.error);
      return r.data;
    },
  );

  return useMemo(() => {
    const merged = mergeRatingRows([
      ...ratingsFromSessions(sessions, playerName),
      ...ratingsFromEncSummary(encSummary ?? { registered: false, username: "", totalGames: 0, lastPlayedAtMs: null, perfs: [] }),
      ...ratingsFromGameHistory(info),
    ]);
    return merged;
  }, [sessions, playerName, encSummary, info]);
}

export function RatingsList({ playerName, info }: { playerName: string; info: PlayerGameInfo }) {
  const { t } = useTranslation();
  const rows = useAllPlayerRatings(playerName, info);

  if (rows.length === 0) {
    return (
      <Text size="sm" c="dimmed" ta="center" py="sm">
        {t("Home.Personal.NoRatings")}
      </Text>
    );
  }

  return (
    <Stack gap="xs">
      <Text fw={600} size="sm">
        {t("Home.Personal.AllRatings")}
      </Text>
      <Table striped highlightOnHover withTableBorder layout="fixed">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t("Home.Personal.RatingSite")}</Table.Th>
            <Table.Th>{t("Home.Personal.RatingCategory")}</Table.Th>
            <Table.Th ta="right">{t("Home.Personal.RatingValue")}</Table.Th>
            <Table.Th ta="right">{t("Common.Games")}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row) => (
            <Table.Tr key={`${row.site}-${row.category}`}>
              <Table.Td>
                <Text size="sm">{row.site}</Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm">{row.category}</Text>
              </Table.Td>
              <Table.Td ta="right">
                <Group gap={6} justify="flex-end" wrap="nowrap">
                  {row.diff != null && row.diff !== 0 && (
                    <Badge
                      size="xs"
                      variant="light"
                      color={row.diff > 0 ? "green" : "red"}
                    >
                      {row.diff > 0 ? `+${row.diff}` : row.diff}
                    </Badge>
                  )}
                  <Text fw={700} size="sm">
                    {row.rating}
                  </Text>
                </Group>
              </Table.Td>
              <Table.Td ta="right">
                <Text size="sm" c="dimmed">
                  {row.games ?? "—"}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
