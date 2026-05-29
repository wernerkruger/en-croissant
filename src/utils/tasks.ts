import { z } from "zod";

export const trainingTaskSchema = z.object({
    id: z.string(),
    /** Username of the profile that owns this task. */
    user: z.string(),
    title: z.string(),
    description: z.string().optional(),
    /** Due date stored as a local calendar day in YYYY-MM-DD form. */
    dueDate: z.string(),
    completed: z.boolean(),
    completedAt: z.number().optional(),
    createdAt: z.number(),
});

export type TrainingTask = z.infer<typeof trainingTaskSchema>;

/** Format a Date as a local YYYY-MM-DD day key (no timezone shifting). */
export function toDayKey(date: Date): string {
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, "0");
    const day = `${date.getDate()}`.padStart(2, "0");
    return `${year}-${month}-${day}`;
}

/** Parse a YYYY-MM-DD day key into a local Date at midnight. */
export function fromDayKey(dayKey: string): Date {
    const [year, month, day] = dayKey.split("-").map((n) => Number.parseInt(n, 10));
    return new Date(year, (month || 1) - 1, day || 1);
}
