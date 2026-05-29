import type { OpponentSettings } from "@/components/boards/OpponentForm";

const STYLE_BOT_ELO_RE = /^StyleBot_(\d+)_/i;

/** ELO embedded in `StyleBot_<rating>_<source>` bot usernames. */
export function parseStyleBotEloFromName(name: string | undefined | null): number | null {
  if (!name) return null;
  const m = name.match(STYLE_BOT_ELO_RE);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(5000, Math.max(500, n));
}

export function engineOpponentElo(
  settings: Extract<OpponentSettings, { type: "engine" }>,
): number | null {
  if (settings.styleBotProfileId) {
    const fromName = parseStyleBotEloFromName(settings.name);
    if (fromName != null) return fromName;
    if (settings.limitElo != null) {
      return Math.min(5000, Math.max(500, Math.round(settings.limitElo)));
    }
  }
  if (settings.limitStrength) {
    return Math.min(5000, Math.max(500, Math.round(settings.limitElo ?? 1500)));
  }
  const fromName = parseStyleBotEloFromName(settings.name);
  return fromName;
}
