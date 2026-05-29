"use no memo";
import { ActionIcon, AppShellSection, Stack, Tooltip } from "@mantine/core";
import {
  type Icon,
  IconBook2,
  IconChess,
  IconClipboardList,
  IconCpu,
  IconDatabase,
  IconFiles,
  IconLogout,
  IconSettings,
  IconTrophy,
  IconUser,
} from "@tabler/icons-react";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { useSetAtom } from "jotai";
import cx from "clsx";
import { useTranslation } from "react-i18next";
import { currentUserAtom } from "@/state/atoms";
import classes from "./Sidebar.module.css";

interface NavbarLinkProps {
  icon: Icon;
  label: string;
  url: string;
  active?: boolean;
}

function NavbarLink({ url, icon: Icon, label }: NavbarLinkProps) {
  const match = useMatchRoute();
  return (
    <Tooltip label={label} position="right">
      <Link
        to={url}
        className={cx(classes.link, {
          [classes.active]: match({ to: url, fuzzy: true }) !== false,
        })}
      >
        <Icon size="1.5rem" stroke={1.5} />
      </Link>
    </Tooltip>
  );
}

const linksdata = [
  { icon: IconChess, label: "Board", url: "/" },
  { icon: IconTrophy, label: "Tournament", url: "/tournaments" },
  { icon: IconUser, label: "User", url: "/accounts" },
  { icon: IconFiles, label: "Files", url: "/files" },
  {
    icon: IconDatabase,
    label: "Databases",
    url: "/databases",
  },
  { icon: IconCpu, label: "Engines", url: "/engines" },
  { icon: IconBook2, label: "Library", url: "/library" },
  { icon: IconClipboardList, label: "Tasks", url: "/tasks" },
];

export function SideBar() {
  const { t } = useTranslation();
  const setCurrentUser = useSetAtom(currentUserAtom);

  const links = linksdata.map((link) => (
    <NavbarLink {...link} label={t(`SideBar.${link.label}`)} key={link.label} />
  ));

  return (
    <>
      <AppShellSection grow>
        <Stack justify="center" gap={0}>
          {links}
        </Stack>
      </AppShellSection>
      <AppShellSection>
        <Stack justify="center" align="center" gap={0}>
          <NavbarLink icon={IconSettings} label={t("SideBar.Settings")} url="/settings" />
          <Tooltip label={t("SideBar.Logout", "Log out")} position="right">
            <ActionIcon
              className={classes.link}
              variant="subtle"
              color="gray"
              onClick={() => setCurrentUser(null)}
              aria-label={t("SideBar.Logout", "Log out")}
            >
              <IconLogout size="1.5rem" stroke={1.5} />
            </ActionIcon>
          </Tooltip>
        </Stack>
      </AppShellSection>
    </>
  );
}
