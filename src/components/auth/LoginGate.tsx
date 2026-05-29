import {
  Button,
  Card,
  Center,
  Group,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { IconChess, IconLogin2, IconUserCircle } from "@tabler/icons-react";
import { useAtom } from "jotai";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { currentUserAtom, knownUsersAtom } from "@/state/atoms";

/**
 * Wraps the application and forces the user to pick a local profile before the
 * rest of the UI becomes available. The selected username is reused as the
 * default opponent name when playing against bots/engines.
 */
export function LoginGate({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUser] = useAtom(currentUserAtom);

  if (currentUser && currentUser.trim().length > 0) {
    return <>{children}</>;
  }

  return <LoginScreen onLogin={setCurrentUser} />;
}

function LoginScreen({ onLogin }: { onLogin: (username: string) => void }) {
  const { t } = useTranslation();
  const [knownUsers, setKnownUsers] = useAtom(knownUsersAtom);
  const [username, setUsername] = useState("");

  function login(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    setKnownUsers((prev) => [trimmed, ...prev.filter((u) => u !== trimmed)]);
    onLogin(trimmed);
  }

  return (
    <Center data-tauri-drag-region h="100vh" w="100%" style={{ userSelect: "none" }}>
      <Card withBorder shadow="md" radius="md" w={420} maw="90vw" p="xl">
        <Stack gap="lg">
          <Stack align="center" gap="xs">
            <ThemeIcon size={72} radius="100%" variant="light" color="blue">
              <IconChess size={40} />
            </ThemeIcon>
            <Title order={2}>{t("Login.Title", "Welcome")}</Title>
            <Text c="dimmed" ta="center" size="sm">
              {t(
                "Login.Description",
                "Choose a profile to continue. Your username is also used when playing against bots.",
              )}
            </Text>
          </Stack>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              login(username);
            }}
          >
            <Stack gap="sm">
              <TextInput
                data-autofocus
                label={t("Login.Username", "Username")}
                placeholder={t("Login.UsernamePlaceholder", "Enter a username")}
                value={username}
                onChange={(e) => setUsername(e.currentTarget.value)}
                required
              />
              <Button
                type="submit"
                fullWidth
                leftSection={<IconLogin2 size="1rem" />}
                disabled={username.trim().length === 0}
              >
                {t("Login.Continue", "Log in")}
              </Button>
            </Stack>
          </form>

          {knownUsers.length > 0 && (
            <Stack gap="xs">
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                {t("Login.RecentProfiles", "Recent profiles")}
              </Text>
              {knownUsers.map((user) => (
                <UnstyledButton key={user} onClick={() => login(user)}>
                  <Card withBorder radius="sm" p="xs">
                    <Group gap="sm">
                      <IconUserCircle size={22} />
                      <Text>{user}</Text>
                    </Group>
                  </Card>
                </UnstyledButton>
              ))}
            </Stack>
          )}
        </Stack>
      </Card>
    </Center>
  );
}
