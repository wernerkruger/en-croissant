import { notifications } from "@mantine/notifications";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { syncConfigAtom } from "@/state/atoms";
import type { SyncConfig } from "@/utils/library";
import { isSyncConfigComplete, runSync } from "@/utils/sync";

/** Stable key for “this exact sync configuration”. */
function syncFingerprint(config: SyncConfig): string | null {
  if (!config.enabled || !isSyncConfigComplete(config)) {
    return null;
  }
  return [
    config.host.trim(),
    config.port,
    config.username.trim(),
    config.remoteDir.trim(),
    config.password,
  ].join("\0");
}

/**
 * Runs a one-shot cloud sync shortly after the user unlocks the app, when sync
 * is enabled and fully configured. Renders nothing.
 */
export default function SyncManager() {
  const config = useAtomValue(syncConfigAtom);
  const lastSuccessRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    const fp = syncFingerprint(config);
    if (!fp || fp === lastSuccessRef.current || inFlightRef.current) {
      return;
    }

    inFlightRef.current = true;
    runSync()
      .then(() => {
        lastSuccessRef.current = fp;
      })
      .catch((e) => {
        notifications.show({
          title: "Startup sync failed",
          message: String(e),
          color: "red",
        });
      })
      .finally(() => {
        inFlightRef.current = false;
      });
  }, [config]);

  return null;
}
