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
import {
  IconChess,
  IconLogin2,
  IconUserCircle,
  IconUserPlus,
} from "@tabler/icons-react";
import { useAtom, useSetAtom } from "jotai";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { currentUserAtom, knownUsersAtom, sessionUnlockedAtom } from "@/state/atoms";

/**
 * Wraps the application and forces the user to pick a local profile before the
 * rest of the UI becomes available. The selected username is reused as the
 * default opponent name when playing against bots/engines.
 *
 * The remembered profile is preserved between launches, but on each launch the
 * user must confirm they want to continue as that profile (or switch to a
 * different one) before the app unlocks.
 */
export function LoginGate({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUser] = useAtom(currentUserAtom);
  const [sessionUnlocked, setSessionUnlocked] = useAtom(sessionUnlockedAtom);

  const hasUser = !!currentUser && currentUser.trim().length > 0;

  if (hasUser && sessionUnlocked) {
    return <>{children}</>;
  }

  if (hasUser) {
    return (
      <WelcomeBackScreen
        username={currentUser as string}
        onContinue={() => setSessionUnlocked(true)}
        onSwitchUser={() => setCurrentUser(null)}
      />
    );
  }

  return <LoginScreen />;
}

function WelcomeBackScreen({
  username,
  onContinue,
  onSwitchUser,
}: {
  username: string;
  onContinue: () => void;
  onSwitchUser: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Center data-tauri-drag-region h="100vh" w="100%" style={{ userSelect: "none" }}>
      <Card withBorder shadow="md" radius="md" w={420} maw="90vw" p="xl">
        <Stack gap="lg">
          <Stack align="center" gap="xs">
            <ThemeIcon size={72} radius="100%" variant="light" color="blue">
              <IconUserCircle size={40} />
            </ThemeIcon>
            <Title order={2}>{t("Login.WelcomeBack", "Welcome back")}</Title>
            <Text c="dimmed" ta="center" size="sm">
              {t("Login.ContinueAsPrompt", "You are signed in as")}
            </Text>
            <Text fw={700} size="lg">
              {username}
            </Text>
          </Stack>

          <Stack gap="sm">
            <Button
              fullWidth
              leftSection={<IconLogin2 size="1rem" />}
              onClick={onContinue}
            >
              {t("Login.ContinueAs", "Continue as {{user}}", { user: username })}
            </Button>
            <Button
              fullWidth
              variant="default"
              leftSection={<IconUserPlus size="1rem" />}
              onClick={onSwitchUser}
            >
              {t("Login.SwitchUser", "Log in as someone else")}
            </Button>
          </Stack>
        </Stack>
      </Card>
    </Center>
  );
}

function LoginScreen() {
  const { t } = useTranslation();
  const setCurrentUser = useSetAtom(currentUserAtom);
  const setSessionUnlocked = useSetAtom(sessionUnlockedAtom);
  const [knownUsers, setKnownUsers] = useAtom(knownUsersAtom);
  const [username, setUsername] = useState("");

  function login(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    setKnownUsers((prev) => [trimmed, ...prev.filter((u) => u !== trimmed)]);
    setCurrentUser(trimmed);
    setSessionUnlocked(true);
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
