import { Select } from "@mantine/core";
import { useAtomValue } from "jotai";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import type { ChesscomBotManifestEntry } from "@/bindings";
import { commands } from "@/bindings";
import { enginesAtom } from "@/state/atoms";
import type { LocalEngine } from "@/utils/engines";
import { unwrap } from "@/utils/unwrap";
import type { OpponentSettings } from "./OpponentForm";

const ENGINE_PREFIX = "engine:";
const BOT_PREFIX = "bot:";

function selectionValue(opponent: OpponentSettings): string {
  if (opponent.type !== "engine") return "";
  if (opponent.styleBotProfileId) return `${BOT_PREFIX}${opponent.styleBotProfileId}`;
  if (opponent.engine?.id) return `${ENGINE_PREFIX}${opponent.engine.id}`;
  return "";
}

export function EngineOrBotSelect({
  opponent,
  setOpponent,
}: {
  opponent: Extract<OpponentSettings, { type: "engine" }>;
  setOpponent: React.Dispatch<React.SetStateAction<OpponentSettings>>;
}) {
  const { t } = useTranslation();
  const allEngines = useAtomValue(enginesAtom);
  const engines = (allEngines ?? []).filter((e): e is LocalEngine => e.type === "local");

  const { data: styleBots } = useSWR("chesscom-bots", async () =>
    unwrap(await commands.listChesscomBotProfiles()),
  );

  const selectData = useMemo(() => {
    const groups: { group: string; items: { value: string; label: string }[] }[] = [];
    if (engines.length > 0) {
      groups.push({
        group: t("Common.Engine"),
        items: engines.map((engine) => ({
          value: `${ENGINE_PREFIX}${engine.id}`,
          label: engine.name,
        })),
      });
    }
    const bots = styleBots ?? [];
    if (bots.length > 0) {
      groups.push({
        group: t("Board.Opponent.StyleBotsGroup"),
        items: bots.map((b: ChesscomBotManifestEntry) => ({
          value: `${BOT_PREFIX}${b.id}`,
          label: `${b.botUsername} (${b.targetElo})`,
        })),
      });
    }
    return groups;
  }, [engines, styleBots, t]);

  useEffect(() => {
    if (opponent.type !== "engine") return;
    if (opponent.styleBotProfileId) return;
    if (engines.length === 0) return;
    if (opponent.engine === null) {
      setOpponent((prev) => {
        if (prev.type !== "engine") return prev;
        return { ...prev, engine: engines[0], engineSettings: engines[0].settings ?? undefined };
      });
    }
  }, [engines, opponent.engine, opponent.styleBotProfileId, opponent.type, setOpponent]);

  useEffect(() => {
    if (opponent.type !== "engine") return;
    if (!opponent.styleBotProfileId) return;
    if (opponent.engine) return;
    if (engines.length === 0) return;
    setOpponent((prev) => {
      if (prev.type !== "engine") return prev;
      return { ...prev, engine: engines[0], engineSettings: engines[0].settings ?? undefined };
    });
  }, [engines, opponent.engine, opponent.styleBotProfileId, opponent.type, setOpponent]);

  return (
    <Select
      allowDeselect={false}
      label={t("Board.Opponent.EngineOrBot")}
      description={t("Board.Opponent.EngineOrBotHint")}
      data={selectData}
      value={selectionValue(opponent)}
      onChange={(value) => {
        if (!value) return;
        if (value.startsWith(BOT_PREFIX)) {
          const id = value.slice(BOT_PREFIX.length);
          const bot = styleBots?.find((b) => b.id === id);
          setOpponent((prev) => {
            if (prev.type !== "engine") return prev;
            const engine = prev.engine ?? engines[0] ?? null;
            return {
              ...prev,
              styleBotProfileId: id,
              name: bot?.botUsername ?? prev.name,
              limitStrength: true,
              limitElo: bot?.targetElo ?? prev.limitElo,
              engine,
              engineSettings: engine?.settings ?? undefined,
            };
          });
          return;
        }
        if (value.startsWith(ENGINE_PREFIX)) {
          const id = value.slice(ENGINE_PREFIX.length);
          const engine = engines.find((e) => e.id === id) ?? null;
          setOpponent((prev) => {
            if (prev.type !== "engine") return prev;
            return {
              ...prev,
              engine,
              engineSettings: engine?.settings ?? undefined,
              styleBotProfileId: undefined,
              name: engine?.name ?? prev.name,
            };
          });
        }
      }}
    />
  );
}
