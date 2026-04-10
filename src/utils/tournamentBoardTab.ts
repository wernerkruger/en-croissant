import { getDefaultStore } from "jotai";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import { genID, type Tab } from "@/utils/tabs";

/**
 * Ensures a tab with `type: "play"` is active so BoardGame mounts.
 * Call before setting tournament launch payload and navigating to `/`.
 */
export function ensureActivePlayTab(playTabDisplayName: string): void {
    const store = getDefaultStore();
    const tabs = store.get(tabsAtom);
    const activeId = store.get(activeTabAtom);
    const active = tabs.find((x) => x.value === activeId);

    if (active?.type === "play") {
        return;
    }

    const play = tabs.find((x) => x.type === "play");
    if (play) {
        store.set(activeTabAtom, play.value);
        return;
    }

    const newTab = tabs.find((x) => x.type === "new");
    if (newTab) {
        store.set(
            tabsAtom,
            tabs.map((tab) =>
                tab.value === newTab.value
                    ? { ...tab, type: "play" as const, name: playTabDisplayName }
                    : tab,
            ),
        );
        store.set(activeTabAtom, newTab.value);
        return;
    }

    const id = genID();
    const next: Tab = {
        name: playTabDisplayName,
        value: id,
        type: "play",
        gameOrigin: { kind: "none" },
    };
    store.set(tabsAtom, [...tabs, next]);
    store.set(activeTabAtom, id);
}
