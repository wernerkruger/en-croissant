import {
  Alert,
  Button,
  Group,
  NumberInput,
  PasswordInput,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCloudUp, IconInfoCircle, IconPlugConnected } from "@tabler/icons-react";
import { useAtom } from "jotai";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { syncConfigAtom } from "@/state/atoms";
import { runSync, testSync } from "@/utils/sync";

export default function SyncSettings() {
  const { t } = useTranslation();
  const [config, setConfig] = useAtom(syncConfigAtom);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const handleTest = async () => {
    setTesting(true);
    try {
      await testSync(config);
      notifications.show({
        title: t("Settings.Sync.TestOk", "Connection successful"),
        message: t("Settings.Sync.TestOkDesc", "Connected and the chess-data folder is ready."),
        color: "green",
      });
    } catch (e) {
      notifications.show({
        title: t("Settings.Sync.TestFailed", "Connection failed"),
        message: String(e),
        color: "red",
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await runSync();
      notifications.show({
        title: t("Settings.Sync.Done", "Sync complete"),
        message: t("Settings.Sync.DoneDesc", {
          defaultValue:
            "{{books}} books, {{games}} pinned games. Downloaded {{down}}, uploaded {{up}}.",
          books: res.booksTotal,
          games: res.pinnedTotal,
          down: res.downloaded,
          up: res.uploaded,
        }),
        color: "green",
      });
    } catch (e) {
      notifications.show({
        title: t("Settings.Sync.Failed", "Sync failed"),
        message: String(e),
        color: "red",
      });
    } finally {
      setSyncing(false);
    }
  };

  const lastSync =
    config.lastSyncAt > 0
      ? new Date(config.lastSyncAt).toLocaleString()
      : t("Settings.Sync.Never", "never");

  return (
    <Stack>
      <Text size="lg" fw={500}>
        {t("Settings.Sync", "Cloud sync")}
      </Text>
      <Text size="xs" c="dimmed" mt={-8}>
        {t(
          "Settings.Sync.Desc",
          "Back up and share your books and pinned games over SFTP. Credentials are stored only on this computer.",
        )}
      </Text>

      <Alert variant="light" color="blue" icon={<IconInfoCircle size="1rem" />}>
        {t(
          "Settings.Sync.Hint",
          "Books are uploaded to a 'books' folder and pinned games to 'manifest.json' inside your remote folder. On conflict, the most recently changed item wins.",
        )}
      </Alert>

      <Switch
        label={t("Settings.Sync.Enable", "Enable cloud sync")}
        description={t("Settings.Sync.EnableDesc", "Also sync automatically on startup after login.")}
        checked={config.enabled}
        onChange={(e) => {
          const checked = e.currentTarget.checked;
          setConfig((prev) => ({ ...prev, enabled: checked }));
        }}
      />

      <Group grow align="flex-start">
        <TextInput
          label={t("Settings.Sync.Host", "Host")}
          value={config.host}
          onChange={(e) => {
            const value = e.currentTarget.value;
            setConfig((prev) => ({ ...prev, host: value }));
          }}
        />
        <NumberInput
          label={t("Settings.Sync.Port", "Port")}
          value={config.port}
          min={1}
          max={65535}
          allowDecimal={false}
          onChange={(value) => {
            const port = typeof value === "number" ? value : Number.parseInt(String(value), 10) || 22;
            setConfig((prev) => ({ ...prev, port }));
          }}
          style={{ maxWidth: 140 }}
        />
      </Group>

      <Group grow align="flex-start">
        <TextInput
          label={t("Settings.Sync.Username", "Username")}
          value={config.username}
          onChange={(e) => {
            const value = e.currentTarget.value;
            setConfig((prev) => ({ ...prev, username: value }));
          }}
        />
        <PasswordInput
          label={t("Settings.Sync.Password", "Password")}
          value={config.password}
          onChange={(e) => {
            const value = e.currentTarget.value;
            setConfig((prev) => ({ ...prev, password: value }));
          }}
        />
      </Group>

      <TextInput
        label={t("Settings.Sync.RemoteDir", "Remote folder")}
        value={config.remoteDir}
        onChange={(e) => {
          const value = e.currentTarget.value;
          setConfig((prev) => ({ ...prev, remoteDir: value }));
        }}
      />

      <Group>
        <Button
          variant="default"
          leftSection={<IconPlugConnected size="1rem" />}
          loading={testing}
          onClick={handleTest}
        >
          {t("Settings.Sync.Test", "Test connection")}
        </Button>
        <Button leftSection={<IconCloudUp size="1rem" />} loading={syncing} onClick={handleSync}>
          {t("Settings.Sync.Now", "Sync now")}
        </Button>
      </Group>

      <Text size="xs" c="dimmed">
        {t("Settings.Sync.LastSync", "Last sync")}: {lastSync}
      </Text>
    </Stack>
  );
}
