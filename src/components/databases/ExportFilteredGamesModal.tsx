import {
  Button,
  Group,
  Modal,
  SegmentedControl,
  Select,
  Stack,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { resolve } from "@tauri-apps/api/path";
import { exists } from "@tauri-apps/plugin-fs";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import { getDatabasesDir } from "@/utils/directories";
import { getDatabases, isEncLocalPlayedGamesDb, type SuccessDatabaseInfo } from "@/utils/db";

export type ExportFilteredMode = "new" | "existing";

function sanitizeDatabaseFilename(name: string): string {
  const trimmed = name.trim().replace(/\.db3$/i, "");
  if (!trimmed) return "filtered-games";
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
  return safe || "filtered-games";
}

type Props = {
  opened: boolean;
  onClose: () => void;
  sourceFile: string;
  loading: boolean;
  onExport: (params: {
    mode: ExportFilteredMode;
    destPath: string;
    title: string;
    append: boolean;
  }) => Promise<number>;
};

export function ExportFilteredGamesModal({
  opened,
  onClose,
  sourceFile,
  loading,
  onExport,
}: Props) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<ExportFilteredMode>("new");
  const [exportName, setExportName] = useState("");
  const [existingDb, setExistingDb] = useState<string | null>(null);

  const { data: databases } = useSWR(opened ? "databases" : null, () => getDatabases());

  const existingDbOptions = (databases ?? [])
    .filter((d): d is SuccessDatabaseInfo => d.type === "success")
    .filter((d) => d.file !== sourceFile && !isEncLocalPlayedGamesDb(d.file))
    .map((d) => ({ value: d.file, label: d.title || d.filename }));

  function resetAndClose() {
    setMode("new");
    setExportName("");
    setExistingDb(null);
    onClose();
  }

  async function onConfirm() {
    if (mode === "new") {
      const title = exportName.trim();
      if (!title) {
        notifications.show({
          color: "red",
          title: t("Common.Error"),
          message: t("Databases.Game.ExportNameRequired"),
        });
        return;
      }
      try {
        const base = sanitizeDatabaseFilename(title);
        const dir = await getDatabasesDir();
        const destPath = await resolve(dir, `${base}.db3`);
        if (await exists(destPath)) {
          notifications.show({
            color: "red",
            title: t("Common.Error"),
            message: t("Databases.Game.ExportFileExists"),
          });
          return;
        }
        const n = await onExport({ mode: "new", destPath, title, append: false });
        notifications.show({
          color: "green",
          title: t("Databases.Game.ExportSuccessTitle"),
          message: t("Databases.Game.ExportSuccessMessage", { count: n }),
        });
        resetAndClose();
      } catch (e) {
        notifications.show({
          color: "red",
          title: t("Common.Error"),
          message: e instanceof Error ? e.message : String(e),
        });
      }
      return;
    }

    if (!existingDb) {
      notifications.show({
        color: "red",
        title: t("Common.Error"),
        message: t("Databases.Game.ExportExistingRequired"),
      });
      return;
    }
    try {
      const n = await onExport({
        mode: "existing",
        destPath: existingDb,
        title: "",
        append: true,
      });
      notifications.show({
        color: "green",
        title: t("Databases.Game.ExportAppendSuccessTitle"),
        message: t("Databases.Game.ExportAppendSuccessMessage", { count: n }),
      });
      resetAndClose();
    } catch (e) {
      notifications.show({
        color: "red",
        title: t("Common.Error"),
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <Modal
      opened={opened}
      onClose={resetAndClose}
      title={t("Databases.Game.ExportModalTitle")}
    >
      <Stack>
        <SegmentedControl
          value={mode}
          onChange={(v) => setMode(v as ExportFilteredMode)}
          data={[
            { label: t("Databases.Game.ExportModeNew"), value: "new" },
            { label: t("Databases.Game.ExportModeExisting"), value: "existing" },
          ]}
        />
        {mode === "new" ? (
          <TextInput
            label={t("Databases.Game.ExportNameLabel")}
            placeholder={t("Databases.Game.ExportNamePlaceholder")}
            value={exportName}
            onChange={(e) => setExportName(e.currentTarget.value)}
            autoFocus
          />
        ) : (
          <Select
            label={t("Databases.Game.ExportExistingLabel")}
            placeholder={t("Databases.Game.ExportExistingPlaceholder")}
            data={existingDbOptions}
            value={existingDb}
            onChange={setExistingDb}
            searchable
            nothingFoundMessage={t("Databases.Game.ExportExistingNone")}
            autoFocus
          />
        )}
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={resetAndClose}>
            {t("Common.Cancel")}
          </Button>
          <Button loading={loading} onClick={() => void onConfirm()}>
            {mode === "new"
              ? t("Databases.Game.ExportConfirm")
              : t("Databases.Game.ExportAppendConfirm")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
