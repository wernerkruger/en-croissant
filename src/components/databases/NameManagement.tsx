import {
  Button,
  Group,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { useToggle } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconSearch } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PlayerNameMatch } from "@/bindings";
import { commands } from "@/bindings";
import ConfirmModal from "@/components/common/ConfirmModal";
import { formatNumber } from "@/utils/format";
import { unwrap } from "@/utils/unwrap";

function parseNameTokens(input: string): string[] {
  return input
    .split(/[,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function NameManagement({ file }: { file: string }) {
  const { t } = useTranslation();
  const [tokensInput, setTokensInput] = useState("");
  const [canonicalName, setCanonicalName] = useState("");
  const [targetPlayerId, setTargetPlayerId] = useState<string | null>(null);
  const [matches, setMatches] = useState<PlayerNameMatch[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [applyLoading, setApplyLoading] = useState(false);
  const [confirmOpen, toggleConfirm] = useToggle();

  const [debouncedTokens] = useDebouncedValue(tokensInput, 400);
  const [debouncedCanonical] = useDebouncedValue(canonicalName, 400);

  const parsedTokens = useMemo(() => parseNameTokens(debouncedTokens), [debouncedTokens]);

  useEffect(() => {
    if (parsedTokens.length === 0 && debouncedCanonical.trim().length === 0) {
      setMatches([]);
      return;
    }

    let cancelled = false;
    setPreviewLoading(true);
    commands
      .previewPlayerNameConsolidation(file, parsedTokens, debouncedCanonical.trim())
      .then((res) => {
        if (cancelled) return;
        const data = unwrap(res);
        setMatches(data);
        if (data.length > 0) {
          const preferred =
            data.find((m) => m.name.toLowerCase() === debouncedCanonical.trim().toLowerCase()) ??
            data[0];
          setTargetPlayerId(String(preferred.id));
        } else {
          setTargetPlayerId(null);
        }
      })
      .catch(() => {
        if (!cancelled) setMatches([]);
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [file, parsedTokens, debouncedCanonical]);

  const targetOptions = matches.map((m) => ({
    value: String(m.id),
    label: `${m.name} (${formatNumber(Number(m.game_count))} ${t("Databases.NameManagement.Games")})`,
  }));

  async function applyConsolidation() {
    const canonical = canonicalName.trim();
    if (!canonical) {
      notifications.show({
        color: "red",
        title: t("Common.Error"),
        message: t("Databases.NameManagement.CanonicalRequired"),
      });
      return;
    }
    if (matches.length === 0) {
      notifications.show({
        color: "red",
        title: t("Common.Error"),
        message: t("Databases.NameManagement.NoMatches"),
      });
      return;
    }

    setApplyLoading(true);
    try {
      const result = unwrap(
        await commands.consolidatePlayerNames(
          file,
          parsedTokens,
          canonical,
          targetPlayerId ? Number(targetPlayerId) : null,
        ),
      );
      notifications.show({
        color: "green",
        title: t("Databases.NameManagement.SuccessTitle"),
        message: t("Databases.NameManagement.SuccessMessage", {
          merged: result.players_merged,
          games: result.games_updated,
          name: canonical,
        }),
      });
      setTokensInput("");
      setCanonicalName("");
      setMatches([]);
      setTargetPlayerId(null);
    } catch (e) {
      notifications.show({
        color: "red",
        title: t("Common.Error"),
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setApplyLoading(false);
      toggleConfirm(false);
    }
  }

  return (
    <Stack>
      <Text fz="lg" fw="bold">
        {t("Databases.NameManagement.Title")}
      </Text>
      <Text fz="sm" c="dimmed">
        {t("Databases.NameManagement.Description")}
      </Text>

      <TextInput
        label={t("Databases.NameManagement.TokensLabel")}
        description={t("Databases.NameManagement.TokensDesc")}
        placeholder={t("Databases.NameManagement.TokensPlaceholder")}
        value={tokensInput}
        onChange={(e) => setTokensInput(e.currentTarget.value)}
      />

      <TextInput
        label={t("Databases.NameManagement.CanonicalLabel")}
        description={t("Databases.NameManagement.CanonicalDesc")}
        placeholder={t("Databases.NameManagement.CanonicalPlaceholder")}
        value={canonicalName}
        onChange={(e) => setCanonicalName(e.currentTarget.value)}
      />

      {matches.length > 0 && (
        <>
          <Select
            label={t("Databases.NameManagement.TargetLabel")}
            description={t("Databases.NameManagement.TargetDesc")}
            data={targetOptions}
            value={targetPlayerId}
            onChange={setTargetPlayerId}
            allowDeselect={false}
          />

          <Table striped highlightOnHover withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t("Common.Name")}</Table.Th>
                <Table.Th ta="right">{t("Databases.NameManagement.Games")}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {matches.map((m) => (
                <Table.Tr key={m.id}>
                  <Table.Td>
                    <Group gap="xs">
                      {String(m.id) === targetPlayerId && (
                        <Text span c="blue" fz="xs">
                          →
                        </Text>
                      )}
                      <Text span fw={String(m.id) === targetPlayerId ? 600 : 400}>
                        {m.name}
                      </Text>
                    </Group>
                  </Table.Td>
                  <Table.Td ta="right">{formatNumber(Number(m.game_count))}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </>
      )}

      {previewLoading && (
        <Text fz="sm" c="dimmed">
          {t("Databases.NameManagement.Searching")}
        </Text>
      )}

      {!previewLoading && parsedTokens.length > 0 && matches.length === 0 && (
        <Text fz="sm" c="dimmed">
          {t("Databases.NameManagement.NoMatches")}
        </Text>
      )}

      <Group>
        <Button
          leftSection={<IconSearch size="1rem" />}
          variant="default"
          loading={previewLoading}
          onClick={() => {
            setTokensInput((v) => v.trim());
            setCanonicalName((v) => v.trim());
          }}
        >
          {t("Databases.NameManagement.Refresh")}
        </Button>
        <Button
          disabled={matches.length === 0 || !canonicalName.trim()}
          loading={applyLoading}
          onClick={() => toggleConfirm(true)}
        >
          {t("Databases.NameManagement.Apply")}
        </Button>
      </Group>

      <ConfirmModal
        title={t("Databases.NameManagement.ConfirmTitle")}
        description={t("Databases.NameManagement.ConfirmDesc", {
          count: matches.length,
          name: canonicalName.trim(),
        })}
        opened={confirmOpen}
        onClose={() => toggleConfirm(false)}
        onConfirm={() => void applyConsolidation()}
        confirmLabel={t("Databases.NameManagement.Apply")}
      />
    </Stack>
  );
}
