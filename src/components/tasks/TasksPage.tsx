import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import { DatePicker, DatePickerInput } from "@mantine/dates";
import {
  IconCalendarEvent,
  IconChecklist,
  IconClipboardList,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import dayjs from "dayjs";
import { useAtom, useAtomValue } from "jotai";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { currentUserAtom, trainingTasksAtom } from "@/state/atoms";
import { genID } from "@/utils/tabs";
import { toDayKey, type TrainingTask } from "@/utils/tasks";

function TasksPage() {
  const { t } = useTranslation();
  const [tasks, setTasks] = useAtom(trainingTasksAtom);
  const currentUser = useAtomValue(currentUserAtom) ?? "";

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState<string | null>(toDayKey(new Date()));
  const [selectedDay, setSelectedDay] = useState<string | null>(toDayKey(new Date()));

  const myTasks = useMemo(
    () => tasks.filter((task) => task.user === currentUser),
    [tasks, currentUser],
  );

  const tasksForDay = useMemo(() => {
    if (!selectedDay) return [];
    return myTasks
      .filter((task) => task.dueDate === selectedDay)
      .sort((a, b) => Number(a.completed) - Number(b.completed) || a.createdAt - b.createdAt);
  }, [myTasks, selectedDay]);

  const daysWithTasks = useMemo(() => {
    const map = new Map<string, { total: number; done: number }>();
    for (const task of myTasks) {
      const entry = map.get(task.dueDate) ?? { total: 0, done: 0 };
      entry.total += 1;
      if (task.completed) entry.done += 1;
      map.set(task.dueDate, entry);
    }
    return map;
  }, [myTasks]);

  function addTask() {
    const trimmed = title.trim();
    if (!trimmed || !dueDate) return;
    const task: TrainingTask = {
      id: genID(),
      user: currentUser,
      title: trimmed,
      description: description.trim() || undefined,
      dueDate,
      completed: false,
      createdAt: Date.now(),
    };
    setTasks((prev) => [...prev, task]);
    setTitle("");
    setDescription("");
    setSelectedDay(dueDate);
  }

  function toggleTask(id: string, completed: boolean) {
    setTasks((prev) =>
      prev.map((task) =>
        task.id === id
          ? { ...task, completed, completedAt: completed ? Date.now() : undefined }
          : task,
      ),
    );
  }

  function deleteTask(id: string) {
    setTasks((prev) => prev.filter((task) => task.id !== id));
  }

  const dayLabel = selectedDay
    ? dayjs(selectedDay).format("dddd, MMMM D, YYYY")
    : t("Tasks.NoDaySelected", "No day selected");

  return (
    <Stack h="100%" p="md" gap="md">
      <Group gap="sm" align="center">
        <IconClipboardList size="1.6rem" />
        <Title>{t("Tasks.Title", "Training Plan")}</Title>
      </Group>

      <Group grow align="flex-start" flex={1} style={{ overflow: "hidden" }} wrap="nowrap">
        <Stack h="100%" gap="md" style={{ overflow: "hidden" }}>
          <Paper withBorder p="md" radius="md">
            <Stack gap="sm">
              <Group gap="xs">
                <IconPlus size="1.1rem" />
                <Text fw={600}>{t("Tasks.New", "New task")}</Text>
              </Group>
              <TextInput
                label={t("Tasks.TaskTitle", "Task")}
                placeholder={t("Tasks.TitlePlaceholder", "e.g. Solve 20 tactics puzzles")}
                value={title}
                onChange={(e) => setTitle(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTask();
                  }
                }}
              />
              <Textarea
                label={t("Tasks.Description", "Details")}
                placeholder={t(
                  "Tasks.DescriptionPlaceholder",
                  "e.g. Read pages 40-55 of My System",
                )}
                value={description}
                onChange={(e) => setDescription(e.currentTarget.value)}
                autosize
                minRows={2}
                maxRows={4}
              />
              <DatePickerInput
                label={t("Tasks.DueDate", "Due date")}
                value={dueDate}
                onChange={setDueDate}
                leftSection={<IconCalendarEvent size="1rem" />}
                required
              />
              <Button
                leftSection={<IconPlus size="1rem" />}
                onClick={addTask}
                disabled={title.trim().length === 0 || !dueDate}
              >
                {t("Tasks.Add", "Add task")}
              </Button>
            </Stack>
          </Paper>

          <Paper withBorder p="md" radius="md" style={{ overflow: "hidden" }}>
            <Stack gap="sm" align="center">
              <Text fw={600} ta="center">
                {t("Tasks.PickDay", "Pick a day")}
              </Text>
              <DatePicker
                value={selectedDay}
                onChange={setSelectedDay}
                renderDay={(date) => {
                  const key = typeof date === "string" ? date : toDayKey(date);
                  const day = dayjs(key).date();
                  const entry = daysWithTasks.get(key);
                  return (
                    <Stack gap={2} align="center" justify="center">
                      <span>{day}</span>
                      {entry && (
                        <span
                          style={{
                            width: 5,
                            height: 5,
                            borderRadius: "50%",
                            backgroundColor:
                              entry.done === entry.total
                                ? "var(--mantine-color-teal-6)"
                                : "var(--mantine-color-blue-6)",
                          }}
                        />
                      )}
                    </Stack>
                  );
                }}
              />
            </Stack>
          </Paper>
        </Stack>

        <Paper withBorder p="md" radius="md" h="100%" style={{ overflow: "hidden" }}>
          <Stack h="100%" gap="sm">
            <Group justify="space-between" align="center">
              <Group gap="xs">
                <IconChecklist size="1.3rem" />
                <Text fw={700} tt="uppercase" size="sm">
                  {t("Tasks.MyTasks", "My Tasks")}
                </Text>
              </Group>
              <Badge variant="light">
                {t("Tasks.DoneCount", "{{done}}/{{total}} done", {
                  done: tasksForDay.filter((task) => task.completed).length,
                  total: tasksForDay.length,
                })}
              </Badge>
            </Group>
            <Text c="dimmed" size="sm">
              {dayLabel}
            </Text>

            <ScrollArea flex={1}>
              {tasksForDay.length === 0 ? (
                <Stack align="center" gap="sm" pt="xl">
                  <ThemeIcon size={64} radius="100%" variant="light" color="gray">
                    <IconChecklist size={32} />
                  </ThemeIcon>
                  <Text c="dimmed">{t("Tasks.NoneForDay", "No tasks for this day")}</Text>
                </Stack>
              ) : (
                <Stack gap="xs">
                  {tasksForDay.map((task) => (
                    <Card key={task.id} withBorder radius="sm" padding="sm">
                      <Group align="flex-start" justify="space-between" wrap="nowrap">
                        <Group align="flex-start" wrap="nowrap" gap="sm">
                          <Checkbox
                            mt={2}
                            checked={task.completed}
                            onChange={(e) => toggleTask(task.id, e.currentTarget.checked)}
                          />
                          <Stack gap={2}>
                            <Text
                              fw={500}
                              td={task.completed ? "line-through" : undefined}
                              c={task.completed ? "dimmed" : undefined}
                            >
                              {task.title}
                            </Text>
                            {task.description && (
                              <Text size="sm" c="dimmed">
                                {task.description}
                              </Text>
                            )}
                          </Stack>
                        </Group>
                        <Tooltip label={t("Common.Delete", "Delete")}>
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            onClick={() => deleteTask(task.id)}
                            aria-label={t("Common.Delete", "Delete")}
                          >
                            <IconTrash size="1rem" />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    </Card>
                  ))}
                </Stack>
              )}
            </ScrollArea>
          </Stack>
        </Paper>
      </Group>
    </Stack>
  );
}

export default TasksPage;
