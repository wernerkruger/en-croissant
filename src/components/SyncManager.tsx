import { notifications } from "@mantine/notifications";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { syncConfigAtom } from "@/state/atoms";
import { runSync } from "@/utils/sync";

/**
 * Runs a one-shot cloud sync shortly after the user unlocks the app, when sync
 * is enabled. Renders nothing.
 */
export default function SyncManager() {
  const config = useAtomValue(syncConfigAtom);
  const started = useRef(false);

  useEffect(() => {
    if (started.current || !config.enabled) return;
    started.current = true;
    runSync().catch((e) => {
      notifications.show({
        title: "Startup sync failed",
        message: String(e),
        color: "red",
      });
    });
  }, [config.enabled]);

  return null;
}
